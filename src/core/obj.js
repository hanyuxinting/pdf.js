/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  bytesToString, createPromiseCapability, createValidAbsoluteUrl, FormatError,
  info, InvalidPDFException, isBool, isNum, isString, MissingDataException,
  PermissionFlag, shadow, stringToPDFString, stringToUTF8String,
  toRomanNumerals, unreachable, warn, XRefEntryException, XRefParseException
} from '../shared/util';
import {
  Dict, isCmd, isDict, isName, isRef, isRefsEqual, isStream, Ref, RefSet,
  RefSetCache
} from './primitives';
import { Lexer, Parser } from './parser';
import { ChunkedStream } from './chunked_stream';
import { CipherTransformFactory } from './crypto';
import { ColorSpace } from './colorspace';

function fetchDestination(dest) {
  return isDict(dest) ? dest.get('D') : dest;
}

class Catalog {
  constructor(pdfManager, xref) {
    this.pdfManager = pdfManager;
    this.xref = xref;

    this.catDict = xref.getCatalogObj();
    if (!isDict(this.catDict)) {
      throw new FormatError('Catalog object is not a dictionary.');
    }

    this.fontCache = new RefSetCache();
    this.builtInCMapCache = new Map();
    this.pageKidsCountCache = new RefSetCache();
  }

  get metadata() {
    const streamRef = this.catDict.getRaw('Metadata');
    if (!isRef(streamRef)) {
      return shadow(this, 'metadata', null);
    }

    const suppressEncryption = !(this.xref.encrypt &&
                                 this.xref.encrypt.encryptMetadata);
    const stream = this.xref.fetch(streamRef, suppressEncryption);
    let metadata;

    if (stream && isDict(stream.dict)) {
      const type = stream.dict.get('Type');
      const subtype = stream.dict.get('Subtype');

      if (isName(type, 'Metadata') && isName(subtype, 'XML')) {
        // XXX: This should examine the charset the XML document defines,
        // however since there are currently no real means to decode
        // arbitrary charsets, let's just hope that the author of the PDF
        // was reasonable enough to stick with the XML default charset,
        // which is UTF-8.
        try {
          metadata = stringToUTF8String(bytesToString(stream.getBytes()));
        } catch (e) {
          if (e instanceof MissingDataException) {
            throw e;
          }
          info('Skipping invalid metadata.');
        }
      }
    }
    return shadow(this, 'metadata', metadata);
  }

  get toplevelPagesDict() {
    const pagesObj = this.catDict.get('Pages');
    if (!isDict(pagesObj)) {
      throw new FormatError('Invalid top-level pages dictionary.');
    }
    return shadow(this, 'toplevelPagesDict', pagesObj);
  }

  get documentOutline() {
    let obj = null;
    try {
      obj = this._readDocumentOutline();
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      warn('Unable to read document outline.');
    }
    return shadow(this, 'documentOutline', obj);
  }

  /**
   * @private
   */
  _readDocumentOutline() {
    let obj = this.catDict.get('Outlines');
    if (!isDict(obj)) {
      return null;
    }
    obj = obj.getRaw('First');
    if (!isRef(obj)) {
      return null;
    }

    const root = { items: [], };
    const queue = [{ obj, parent: root, }];
    // To avoid recursion, keep track of the already processed items.
    const processed = new RefSet();
    processed.put(obj);
    const xref = this.xref, blackColor = new Uint8ClampedArray(3);

    while (queue.length > 0) {
      const i = queue.shift();
      const outlineDict = xref.fetchIfRef(i.obj);
      if (outlineDict === null) {
        continue;
      }
      if (!outlineDict.has('Title')) {
        throw new FormatError('Invalid outline item encountered.');
      }

      const data = { url: null, dest: null, };
      Catalog.parseDestDictionary({
        destDict: outlineDict,
        resultObj: data,
        docBaseUrl: this.pdfManager.docBaseUrl,
      });
      const title = outlineDict.get('Title');
      const flags = outlineDict.get('F') || 0;
      const color = outlineDict.getArray('C');
      let rgbColor = blackColor;

      // We only need to parse the color when it's valid, and non-default.
      if (Array.isArray(color) && color.length === 3 &&
          (color[0] !== 0 || color[1] !== 0 || color[2] !== 0)) {
        rgbColor = ColorSpace.singletons.rgb.getRgb(color, 0);
      }

      const outlineItem = {
        dest: data.dest,
        url: data.url,
        unsafeUrl: data.unsafeUrl,
        newWindow: data.newWindow,
        title: stringToPDFString(title),
        color: rgbColor,
        count: outlineDict.get('Count'),
        bold: !!(flags & 2),
        italic: !!(flags & 1),
        items: [],
      };

      i.parent.items.push(outlineItem);
      obj = outlineDict.getRaw('First');
      if (isRef(obj) && !processed.has(obj)) {
        queue.push({ obj, parent: outlineItem, });
        processed.put(obj);
      }
      obj = outlineDict.getRaw('Next');
      if (isRef(obj) && !processed.has(obj)) {
        queue.push({ obj, parent: i.parent, });
        processed.put(obj);
      }
    }
    return (root.items.length > 0 ? root.items : null);
  }

  get permissions() {
    let permissions = null;
    try {
      permissions = this._readPermissions();
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      warn('Unable to read permissions.');
    }
    return shadow(this, 'permissions', permissions);
  }

  /**
   * @private
   */
  _readPermissions() {
    const encrypt = this.xref.trailer.get('Encrypt');
    if (!isDict(encrypt)) {
      return null;
    }

    let flags = encrypt.get('P');
    if (!isNum(flags)) {
      return null;
    }

    // PDF integer objects are represented internally in signed 2's complement
    // form. Therefore, convert the signed decimal integer to a signed 2's
    // complement binary integer so we can use regular bitwise operations on it.
    flags += 2 ** 32;

    const permissions = [];
    for (const key in PermissionFlag) {
      const value = PermissionFlag[key];
      if (flags & value) {
        permissions.push(value);
      }
    }
    return permissions;
  }

  get numPages() {
    const obj = this.toplevelPagesDict.get('Count');
    if (!Number.isInteger(obj)) {
      throw new FormatError(
        'Page count in top-level pages dictionary is not an integer.');
    }
    return shadow(this, 'numPages', obj);
  }

  get destinations() {
    const obj = this._readDests(), dests = Object.create(null);
    if (obj instanceof NameTree) {
      const names = obj.getAll();
      for (let name in names) {
        dests[name] = fetchDestination(names[name]);
      }
    } else if (obj instanceof Dict) {
      obj.forEach(function(key, value) {
        if (value) {
          dests[key] = fetchDestination(value);
        }
      });
    }
    return shadow(this, 'destinations', dests);
  }

  getDestination(destinationId) {
    const obj = this._readDests();
    if (obj instanceof NameTree || obj instanceof Dict) {
      return fetchDestination(obj.get(destinationId) || null);
    }
    return null;
  }

  /**
   * @private
   */
  _readDests() {
    const obj = this.catDict.get('Names');
    if (obj && obj.has('Dests')) {
      return new NameTree(obj.getRaw('Dests'), this.xref);
    } else if (this.catDict.has('Dests')) { // Simple destination dictionary.
      return this.catDict.get('Dests');
    }
  }

  get pageLabels() {
    let obj = null;
    try {
      obj = this._readPageLabels();
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      warn('Unable to read page labels.');
    }
    return shadow(this, 'pageLabels', obj);
  }

  /**
   * @private
   */
  _readPageLabels() {
    const obj = this.catDict.getRaw('PageLabels');
    if (!obj) {
      return null;
    }

    const pageLabels = new Array(this.numPages);
    let style = null, prefix = '';

    const numberTree = new NumberTree(obj, this.xref);
    const nums = numberTree.getAll();
    let currentLabel = '', currentIndex = 1;

    for (let i = 0, ii = this.numPages; i < ii; i++) {
      if (i in nums) {
        const labelDict = nums[i];
        if (!isDict(labelDict)) {
          throw new FormatError('PageLabel is not a dictionary.');
        }

        if (labelDict.has('Type') &&
            !isName(labelDict.get('Type'), 'PageLabel')) {
          throw new FormatError('Invalid type in PageLabel dictionary.');
        }

        if (labelDict.has('S')) {
          const s = labelDict.get('S');
          if (!isName(s)) {
            throw new FormatError('Invalid style in PageLabel dictionary.');
          }
          style = s.name;
        } else {
          style = null;
        }

        if (labelDict.has('P')) {
          const p = labelDict.get('P');
          if (!isString(p)) {
            throw new FormatError('Invalid prefix in PageLabel dictionary.');
          }
          prefix = stringToPDFString(p);
        } else {
          prefix = '';
        }

        if (labelDict.has('St')) {
          const st = labelDict.get('St');
          if (!(Number.isInteger(st) && st >= 1)) {
            throw new FormatError('Invalid start in PageLabel dictionary.');
          }
          currentIndex = st;
        } else {
          currentIndex = 1;
        }
      }

      switch (style) {
        case 'D':
          currentLabel = currentIndex;
          break;
        case 'R':
        case 'r':
          currentLabel = toRomanNumerals(currentIndex, style === 'r');
          break;
        case 'A':
        case 'a':
          const LIMIT = 26; // Use only the characters A-Z, or a-z.
          const A_UPPER_CASE = 0x41, A_LOWER_CASE = 0x61;

          const baseCharCode = (style === 'a' ? A_LOWER_CASE : A_UPPER_CASE);
          const letterIndex = currentIndex - 1;
          const character = String.fromCharCode(baseCharCode +
                                                (letterIndex % LIMIT));
          const charBuf = [];
          for (let j = 0, jj = (letterIndex / LIMIT) | 0; j <= jj; j++) {
            charBuf.push(character);
          }
          currentLabel = charBuf.join('');
          break;
        default:
          if (style) {
            throw new FormatError(
              `Invalid style "${style}" in PageLabel dictionary.`);
          }
          currentLabel = '';
      }

      pageLabels[i] = prefix + currentLabel;
      currentIndex++;
    }
    return pageLabels;
  }

  get pageMode() {
    const obj = this.catDict.get('PageMode');
    let pageMode = 'UseNone'; // Default value.

    if (isName(obj)) {
      switch (obj.name) {
        case 'UseNone':
        case 'UseOutlines':
        case 'UseThumbs':
        case 'FullScreen':
        case 'UseOC':
        case 'UseAttachments':
          pageMode = obj.name;
      }
    }
    return shadow(this, 'pageMode', pageMode);
  }

  get openActionDestination() {
    const obj = this.catDict.get('OpenAction');
    let openActionDest = null;

    if (isDict(obj)) {
      // Convert the OpenAction dictionary into a format that works with
      // `parseDestDictionary`, to avoid having to re-implement those checks.
      const destDict = new Dict(this.xref);
      destDict.set('A', obj);

      const resultObj = { url: null, dest: null, };
      Catalog.parseDestDictionary({ destDict, resultObj, });

      if (Array.isArray(resultObj.dest)) {
        openActionDest = resultObj.dest;
      }
    } else if (Array.isArray(obj)) {
      openActionDest = obj;
    }
    return shadow(this, 'openActionDestination', openActionDest);
  }

  get attachments() {
    const obj = this.catDict.get('Names');
    let attachments = null;

    if (obj && obj.has('EmbeddedFiles')) {
      const nameTree = new NameTree(obj.getRaw('EmbeddedFiles'), this.xref);
      const names = nameTree.getAll();
      for (const name in names) {
        const fs = new FileSpec(names[name], this.xref);
        if (!attachments) {
          attachments = Object.create(null);
        }
        attachments[stringToPDFString(name)] = fs.serializable;
      }
    }
    return shadow(this, 'attachments', attachments);
  }

  get javaScript() {
    const obj = this.catDict.get('Names');

    let javaScript = null;
    function appendIfJavaScriptDict(jsDict) {
      const type = jsDict.get('S');
      if (!isName(type, 'JavaScript')) {
        return;
      }

      let js = jsDict.get('JS');
      if (isStream(js)) {
        js = bytesToString(js.getBytes());
      } else if (!isString(js)) {
        return;
      }

      if (!javaScript) {
        javaScript = [];
      }
      javaScript.push(stringToPDFString(js));
    }

    if (obj && obj.has('JavaScript')) {
      const nameTree = new NameTree(obj.getRaw('JavaScript'), this.xref);
      const names = nameTree.getAll();
      for (const name in names) {
        // We don't use most JavaScript in PDF documents. This code is
        // defensive so we don't cause errors on document load.
        const jsDict = names[name];
        if (isDict(jsDict)) {
          appendIfJavaScriptDict(jsDict);
        }
      }
    }

    // Append OpenAction actions to the JavaScript array.
    const openActionDict = this.catDict.get('OpenAction');
    if (isDict(openActionDict, 'Action')) {
      const actionType = openActionDict.get('S');
      if (isName(actionType, 'Named')) {
        // The named Print action is not a part of the PDF 1.7 specification,
        // but is supported by many PDF readers/writers (including Adobe's).
        const action = openActionDict.get('N');
        if (isName(action, 'Print')) {
          if (!javaScript) {
            javaScript = [];
          }
          javaScript.push('print({});');
        }
      } else {
        appendIfJavaScriptDict(openActionDict);
      }
    }

    return shadow(this, 'javaScript', javaScript);
  }

  cleanup() {
    this.pageKidsCountCache.clear();

    const promises = [];
    this.fontCache.forEach(function(promise) {
      promises.push(promise);
    });

    return Promise.all(promises).then((translatedFonts) => {
      for (let i = 0, ii = translatedFonts.length; i < ii; i++) {
        const font = translatedFonts[i].dict;
        delete font.translated;
      }
      this.fontCache.clear();
      this.builtInCMapCache.clear();
    });
  }

  getPageDict(pageIndex) {
    const capability = createPromiseCapability();
    const nodesToVisit = [this.catDict.getRaw('Pages')];
    const xref = this.xref, pageKidsCountCache = this.pageKidsCountCache;
    let count, currentPageIndex = 0;

    function next() {
      while (nodesToVisit.length) {
        const currentNode = nodesToVisit.pop();

        if (isRef(currentNode)) {
          count = pageKidsCountCache.get(currentNode);
          // Skip nodes where the page can't be.
          if (count > 0 && currentPageIndex + count < pageIndex) {
            currentPageIndex += count;
            continue;
          }

          xref.fetchAsync(currentNode).then(function(obj) {
            if (isDict(obj, 'Page') || (isDict(obj) && !obj.has('Kids'))) {
              if (pageIndex === currentPageIndex) {
                // Cache the Page reference, since it can *greatly* improve
                // performance by reducing redundant lookups in long documents
                // where all nodes are found at *one* level of the tree.
                if (currentNode && !pageKidsCountCache.has(currentNode)) {
                  pageKidsCountCache.put(currentNode, 1);
                }
                capability.resolve([obj, currentNode]);
              } else {
                currentPageIndex++;
                next();
              }
              return;
            }
            nodesToVisit.push(obj);
            next();
          }, capability.reject);
          return;
        }

        // Must be a child page dictionary.
        if (!isDict(currentNode)) {
          capability.reject(new FormatError(
            'Page dictionary kid reference points to wrong type of object.'));
          return;
        }

        count = currentNode.get('Count');
        if (Number.isInteger(count) && count >= 0) {
          // Cache the Kids count, since it can reduce redundant lookups in
          // documents where all nodes are found at *one* level of the tree.
          const objId = currentNode.objId;
          if (objId && !pageKidsCountCache.has(objId)) {
            pageKidsCountCache.put(objId, count);
          }
          // Skip nodes where the page can't be.
          if (currentPageIndex + count <= pageIndex) {
            currentPageIndex += count;
            continue;
          }
        }

        const kids = currentNode.get('Kids');
        if (!Array.isArray(kids)) {
          // Prevent errors in corrupt PDF documents that violate the
          // specification by *inlining* Page dicts directly in the Kids
          // array, rather than using indirect objects (fixes issue9540.pdf).
          if (isName(currentNode.get('Type'), 'Page') ||
              (!currentNode.has('Type') && currentNode.has('Contents'))) {
            if (currentPageIndex === pageIndex) {
              capability.resolve([currentNode, null]);
              return;
            }
            currentPageIndex++;
            continue;
          }

          capability.reject(new FormatError(
            'Page dictionary kids object is not an array.'));
          return;
        }

        // Always check all `Kids` nodes, to avoid getting stuck in an empty
        // node further down in the tree (see issue5644.pdf, issue8088.pdf),
        // and to ensure that we actually find the correct `Page` dict.
        for (let last = kids.length - 1; last >= 0; last--) {
          nodesToVisit.push(kids[last]);
        }
      }
      capability.reject(new Error(`Page index ${pageIndex} not found.`));
    }
    next();
    return capability.promise;
  }

  getPageIndex(pageRef) {
    // The page tree nodes have the count of all the leaves below them. To get
    // how many pages are before we just have to walk up the tree and keep
    // adding the count of siblings to the left of the node.
    const xref = this.xref;

    function pagesBeforeRef(kidRef) {
      let total = 0, parentRef;

      return xref.fetchAsync(kidRef).then(function(node) {
        if (isRefsEqual(kidRef, pageRef) && !isDict(node, 'Page') &&
            !(isDict(node) && !node.has('Type') && node.has('Contents'))) {
          throw new FormatError(
            'The reference does not point to a /Page dictionary.');
        }
        if (!node) {
          return null;
        }
        if (!isDict(node)) {
          throw new FormatError('Node must be a dictionary.');
        }
        parentRef = node.getRaw('Parent');
        return node.getAsync('Parent');
      }).then(function(parent) {
        if (!parent) {
          return null;
        }
        if (!isDict(parent)) {
          throw new FormatError('Parent must be a dictionary.');
        }
        return parent.getAsync('Kids');
      }).then(function(kids) {
        if (!kids) {
          return null;
        }

        const kidPromises = [];
        let found = false;
        for (let i = 0, ii = kids.length; i < ii; i++) {
          const kid = kids[i];
          if (!isRef(kid)) {
            throw new FormatError('Kid must be a reference.');
          }
          if (isRefsEqual(kid, kidRef)) {
            found = true;
            break;
          }
          kidPromises.push(xref.fetchAsync(kid).then(function(kid) {
            if (!isDict(kid)) {
              throw new FormatError('Kid node must be a dictionary.');
            }
            if (kid.has('Count')) {
              total += kid.get('Count');
            } else { // Page leaf node.
              total++;
            }
          }));
        }
        if (!found) {
          throw new FormatError('Kid reference not found in parent\'s kids.');
        }
        return Promise.all(kidPromises).then(function() {
          return [total, parentRef];
        });
      });
    }

    let total = 0;
    function next(ref) {
      return pagesBeforeRef(ref).then(function(args) {
        if (!args) {
          return total;
        }
        const [count, parentRef] = args;
        total += count;
        return next(parentRef);
      });
    }

    return next(pageRef);
  }

  /**
   * @typedef ParseDestDictionaryParameters
   * @property {Dict} destDict - The dictionary containing the destination.
   * @property {Object} resultObj - The object where the parsed destination
   *   properties will be placed.
   * @property {string} docBaseUrl - (optional) The document base URL that is
   *   used when attempting to recover valid absolute URLs from relative ones.
   */

  /**
   * Helper function used to parse the contents of destination dictionaries.
   * @param {ParseDestDictionaryParameters} params
   */
  static parseDestDictionary(params) {
    // Lets URLs beginning with 'www.' default to using the 'http://' protocol.
    function addDefaultProtocolToUrl(url) {
      return (url.startsWith('www.') ? `http://${url}` : url);
    }

    // According to ISO 32000-1:2008, section 12.6.4.7, URIs should be encoded
    // in 7-bit ASCII. Some bad PDFs use UTF-8 encoding; see Bugzilla 1122280.
    function tryConvertUrlEncoding(url) {
      try {
        return stringToUTF8String(url);
      } catch (e) {
        return url;
      }
    }

    const destDict = params.destDict;
    if (!isDict(destDict)) {
      warn('parseDestDictionary: `destDict` must be a dictionary.');
      return;
    }
    const resultObj = params.resultObj;
    if (typeof resultObj !== 'object') {
      warn('parseDestDictionary: `resultObj` must be an object.');
      return;
    }
    const docBaseUrl = params.docBaseUrl || null;

    let action = destDict.get('A'), url, dest;
    if (!isDict(action) && destDict.has('Dest')) {
      // A /Dest entry should *only* contain a Name or an Array, but some bad
      // PDF generators ignore that and treat it as an /A entry.
      action = destDict.get('Dest');
    }

    if (isDict(action)) {
      const actionType = action.get('S');
      if (!isName(actionType)) {
        warn('parseDestDictionary: Invalid type in Action dictionary.');
        return;
      }
      const actionName = actionType.name;

      switch (actionName) {
        case 'URI':
          url = action.get('URI');
          if (isName(url)) {
            // Some bad PDFs do not put parentheses around relative URLs.
            url = '/' + url.name;
          } else if (isString(url)) {
            url = addDefaultProtocolToUrl(url);
          }
          // TODO: pdf spec mentions urls can be relative to a Base
          // entry in the dictionary.
          break;

        case 'GoTo':
          dest = action.get('D');
          break;

        case 'Launch':
          // We neither want, nor can, support arbitrary 'Launch' actions.
          // However, in practice they are mostly used for linking to other PDF
          // files, which we thus attempt to support (utilizing `docBaseUrl`).
          /* falls through */

        case 'GoToR':
          const urlDict = action.get('F');
          if (isDict(urlDict)) {
            // We assume that we found a FileSpec dictionary
            // and fetch the URL without checking any further.
            url = urlDict.get('F') || null;
          } else if (isString(urlDict)) {
            url = urlDict;
          }

          // NOTE: the destination is relative to the *remote* document.
          let remoteDest = action.get('D');
          if (remoteDest) {
            if (isName(remoteDest)) {
              remoteDest = remoteDest.name;
            }
            if (isString(url)) {
              const baseUrl = url.split('#')[0];
              if (isString(remoteDest)) {
                url = baseUrl + '#' + remoteDest;
              } else if (Array.isArray(remoteDest)) {
                url = baseUrl + '#' + JSON.stringify(remoteDest);
              }
            }
          }
          // The 'NewWindow' property, equal to `LinkTarget.BLANK`.
          const newWindow = action.get('NewWindow');
          if (isBool(newWindow)) {
            resultObj.newWindow = newWindow;
          }
          break;

        case 'Named':
          const namedAction = action.get('N');
          if (isName(namedAction)) {
            resultObj.action = namedAction.name;
          }
          break;

        case 'JavaScript':
          const jsAction = action.get('JS');
          let js;

          if (isStream(jsAction)) {
            js = bytesToString(jsAction.getBytes());
          } else if (isString(jsAction)) {
            js = jsAction;
          }

          if (js) {
            // Attempt to recover valid URLs from `JS` entries with certain
            // white-listed formats:
            //  - window.open('http://example.com')
            //  - app.launchURL('http://example.com', true)
            const URL_OPEN_METHODS = [
              'app.launchURL',
              'window.open'
            ];
            const regex = new RegExp(
              '^\\s*(' + URL_OPEN_METHODS.join('|').split('.').join('\\.') +
              ')\\((?:\'|\")([^\'\"]*)(?:\'|\")(?:,\\s*(\\w+)\\)|\\))', 'i');

            const jsUrl = regex.exec(stringToPDFString(js));
            if (jsUrl && jsUrl[2]) {
              url = jsUrl[2];

              if (jsUrl[3] === 'true' && jsUrl[1] === 'app.launchURL') {
                resultObj.newWindow = true;
              }
              break;
            }
          }
          /* falls through */
        default:
          warn(`parseDestDictionary: unsupported action type "${actionName}".`);
          break;
      }
    } else if (destDict.has('Dest')) { // Simple destination.
      dest = destDict.get('Dest');
    }

    if (isString(url)) {
      url = tryConvertUrlEncoding(url);
      const absoluteUrl = createValidAbsoluteUrl(url, docBaseUrl);
      if (absoluteUrl) {
        resultObj.url = absoluteUrl.href;
      }
      resultObj.unsafeUrl = url;
    }
    if (dest) {
      if (isName(dest)) {
        dest = dest.name;
      }
      if (isString(dest) || Array.isArray(dest)) {
        resultObj.dest = dest;
      }
    }
  }
}

var XRef = (function XRefClosure() {
  function XRef(stream, pdfManager) {
    this.stream = stream;
    this.pdfManager = pdfManager;
    this.entries = [];
    this.xrefstms = Object.create(null);
    // prepare the XRef cache
    this.cache = [];
    this.stats = {
      streamTypes: [],
      fontTypes: [],
    };
  }

  XRef.prototype = {
    setStartXRef: function XRef_setStartXRef(startXRef) {
      // Store the starting positions of xref tables as we process them
      // so we can recover from missing data errors
      this.startXRefQueue = [startXRef];
    },

    parse: function XRef_parse(recoveryMode) {
      var trailerDict;
      if (!recoveryMode) {
        trailerDict = this.readXRef();
      } else {
        warn('Indexing all PDF objects');
        trailerDict = this.indexObjects();
      }
      trailerDict.assignXref(this);
      this.trailer = trailerDict;

      let encrypt;
      try {
        encrypt = trailerDict.get('Encrypt');
      } catch (ex) {
        if (ex instanceof MissingDataException) {
          throw ex;
        }
        warn(`XRef.parse - Invalid "Encrypt" reference: "${ex}".`);
      }
      if (isDict(encrypt)) {
        var ids = trailerDict.get('ID');
        var fileId = (ids && ids.length) ? ids[0] : '';
        // The 'Encrypt' dictionary itself should not be encrypted, and by
        // setting `suppressEncryption` we can prevent an infinite loop inside
        // of `XRef_fetchUncompressed` if the dictionary contains indirect
        // objects (fixes issue7665.pdf).
        encrypt.suppressEncryption = true;
        this.encrypt = new CipherTransformFactory(encrypt, fileId,
                                                  this.pdfManager.password);
      }

      // Get the root dictionary (catalog) object, and do some basic validation.
      let root;
      try {
        root = trailerDict.get('Root');
      } catch (ex) {
        if (ex instanceof MissingDataException) {
          throw ex;
        }
        warn(`XRef.parse - Invalid "Root" reference: "${ex}".`);
      }
      if (isDict(root) && root.has('Pages')) {
        this.root = root;
      } else {
        if (!recoveryMode) {
          throw new XRefParseException();
        }
        throw new FormatError('Invalid root reference');
      }
    },

    processXRefTable: function XRef_processXRefTable(parser) {
      if (!('tableState' in this)) {
        // Stores state of the table as we process it so we can resume
        // from middle of table in case of missing data error
        this.tableState = {
          entryNum: 0,
          streamPos: parser.lexer.stream.pos,
          parserBuf1: parser.buf1,
          parserBuf2: parser.buf2,
        };
      }

      var obj = this.readXRefTable(parser);

      // Sanity check
      if (!isCmd(obj, 'trailer')) {
        throw new FormatError(
          'Invalid XRef table: could not find trailer dictionary');
      }
      // Read trailer dictionary, e.g.
      // trailer
      //    << /Size 22
      //      /Root 20R
      //      /Info 10R
      //      /ID [ <81b14aafa313db63dbd6f981e49f94f4> ]
      //    >>
      // The parser goes through the entire stream << ... >> and provides
      // a getter interface for the key-value table
      var dict = parser.getObj();

      // The pdflib PDF generator can generate a nested trailer dictionary
      if (!isDict(dict) && dict.dict) {
        dict = dict.dict;
      }
      if (!isDict(dict)) {
        throw new FormatError(
          'Invalid XRef table: could not parse trailer dictionary');
      }
      delete this.tableState;

      return dict;
    },

    readXRefTable: function XRef_readXRefTable(parser) {
      // Example of cross-reference table:
      // xref
      // 0 1                    <-- subsection header (first obj #, obj count)
      // 0000000000 65535 f     <-- actual object (offset, generation #, f/n)
      // 23 2                   <-- subsection header ... and so on ...
      // 0000025518 00002 n
      // 0000025635 00000 n
      // trailer
      // ...

      var stream = parser.lexer.stream;
      var tableState = this.tableState;
      stream.pos = tableState.streamPos;
      parser.buf1 = tableState.parserBuf1;
      parser.buf2 = tableState.parserBuf2;

      // Outer loop is over subsection headers
      var obj;

      while (true) {
        if (!('firstEntryNum' in tableState) || !('entryCount' in tableState)) {
          if (isCmd(obj = parser.getObj(), 'trailer')) {
            break;
          }
          tableState.firstEntryNum = obj;
          tableState.entryCount = parser.getObj();
        }

        var first = tableState.firstEntryNum;
        var count = tableState.entryCount;
        if (!Number.isInteger(first) || !Number.isInteger(count)) {
          throw new FormatError(
            'Invalid XRef table: wrong types in subsection header');
        }
        // Inner loop is over objects themselves
        for (var i = tableState.entryNum; i < count; i++) {
          tableState.streamPos = stream.pos;
          tableState.entryNum = i;
          tableState.parserBuf1 = parser.buf1;
          tableState.parserBuf2 = parser.buf2;

          var entry = {};
          entry.offset = parser.getObj();
          entry.gen = parser.getObj();
          var type = parser.getObj();

          if (isCmd(type, 'f')) {
            entry.free = true;
          } else if (isCmd(type, 'n')) {
            entry.uncompressed = true;
          }

          // Validate entry obj
          if (!Number.isInteger(entry.offset) || !Number.isInteger(entry.gen) ||
              !(entry.free || entry.uncompressed)) {
            throw new FormatError(
              `Invalid entry in XRef subsection: ${first}, ${count}`);
          }

          // The first xref table entry, i.e. obj 0, should be free. Attempting
          // to adjust an incorrect first obj # (fixes issue 3248 and 7229).
          if (i === 0 && entry.free && first === 1) {
            first = 0;
          }

          if (!this.entries[i + first]) {
            this.entries[i + first] = entry;
          }
        }

        tableState.entryNum = 0;
        tableState.streamPos = stream.pos;
        tableState.parserBuf1 = parser.buf1;
        tableState.parserBuf2 = parser.buf2;
        delete tableState.firstEntryNum;
        delete tableState.entryCount;
      }

      // Sanity check: as per spec, first object must be free
      if (this.entries[0] && !this.entries[0].free) {
        throw new FormatError(
          'Invalid XRef table: unexpected first object');
      }
      return obj;
    },

    processXRefStream: function XRef_processXRefStream(stream) {
      if (!('streamState' in this)) {
        // Stores state of the stream as we process it so we can resume
        // from middle of stream in case of missing data error
        var streamParameters = stream.dict;
        var byteWidths = streamParameters.get('W');
        var range = streamParameters.get('Index');
        if (!range) {
          range = [0, streamParameters.get('Size')];
        }

        this.streamState = {
          entryRanges: range,
          byteWidths,
          entryNum: 0,
          streamPos: stream.pos,
        };
      }
      this.readXRefStream(stream);
      delete this.streamState;

      return stream.dict;
    },

    readXRefStream: function XRef_readXRefStream(stream) {
      var i, j;
      var streamState = this.streamState;
      stream.pos = streamState.streamPos;

      var byteWidths = streamState.byteWidths;
      var typeFieldWidth = byteWidths[0];
      var offsetFieldWidth = byteWidths[1];
      var generationFieldWidth = byteWidths[2];

      var entryRanges = streamState.entryRanges;
      while (entryRanges.length > 0) {
        var first = entryRanges[0];
        var n = entryRanges[1];

        if (!Number.isInteger(first) || !Number.isInteger(n)) {
          throw new FormatError(
            `Invalid XRef range fields: ${first}, ${n}`);
        }
        if (!Number.isInteger(typeFieldWidth) ||
            !Number.isInteger(offsetFieldWidth) ||
            !Number.isInteger(generationFieldWidth)) {
          throw new FormatError(
            `Invalid XRef entry fields length: ${first}, ${n}`);
        }
        for (i = streamState.entryNum; i < n; ++i) {
          streamState.entryNum = i;
          streamState.streamPos = stream.pos;

          var type = 0, offset = 0, generation = 0;
          for (j = 0; j < typeFieldWidth; ++j) {
            type = (type << 8) | stream.getByte();
          }
          // if type field is absent, its default value is 1
          if (typeFieldWidth === 0) {
            type = 1;
          }
          for (j = 0; j < offsetFieldWidth; ++j) {
            offset = (offset << 8) | stream.getByte();
          }
          for (j = 0; j < generationFieldWidth; ++j) {
            generation = (generation << 8) | stream.getByte();
          }
          var entry = {};
          entry.offset = offset;
          entry.gen = generation;
          switch (type) {
            case 0:
              entry.free = true;
              break;
            case 1:
              entry.uncompressed = true;
              break;
            case 2:
              break;
            default:
              throw new FormatError(`Invalid XRef entry type: ${type}`);
          }
          if (!this.entries[first + i]) {
            this.entries[first + i] = entry;
          }
        }

        streamState.entryNum = 0;
        streamState.streamPos = stream.pos;
        entryRanges.splice(0, 2);
      }
    },

    indexObjects: function XRef_indexObjects() {
      // Simple scan through the PDF content to find objects,
      // trailers and XRef streams.
      var TAB = 0x9, LF = 0xA, CR = 0xD, SPACE = 0x20;
      var PERCENT = 0x25, LT = 0x3C;

      function readToken(data, offset) {
        var token = '', ch = data[offset];
        while (ch !== LF && ch !== CR && ch !== LT) {
          if (++offset >= data.length) {
            break;
          }
          token += String.fromCharCode(ch);
          ch = data[offset];
        }
        return token;
      }
      function skipUntil(data, offset, what) {
        var length = what.length, dataLength = data.length;
        var skipped = 0;
        // finding byte sequence
        while (offset < dataLength) {
          var i = 0;
          while (i < length && data[offset + i] === what[i]) {
            ++i;
          }
          if (i >= length) {
            break; // sequence found
          }
          offset++;
          skipped++;
        }
        return skipped;
      }
      var objRegExp = /^(\d+)\s+(\d+)\s+obj\b/;
      const endobjRegExp = /\bendobj[\b\s]$/;
      const nestedObjRegExp = /\s+(\d+\s+\d+\s+obj[\b\s<])$/;
      const CHECK_CONTENT_LENGTH = 25;

      var trailerBytes = new Uint8Array([116, 114, 97, 105, 108, 101, 114]);
      var startxrefBytes = new Uint8Array([115, 116, 97, 114, 116, 120, 114,
                                          101, 102]);
      const objBytes = new Uint8Array([111, 98, 106]);
      var xrefBytes = new Uint8Array([47, 88, 82, 101, 102]);

      // Clear out any existing entries, since they may be bogus.
      this.entries.length = 0;

      var stream = this.stream;
      stream.pos = 0;
      var buffer = stream.getBytes();
      var position = stream.start, length = buffer.length;
      var trailers = [], xrefStms = [];
      while (position < length) {
        var ch = buffer[position];
        if (ch === TAB || ch === LF || ch === CR || ch === SPACE) {
          ++position;
          continue;
        }
        if (ch === PERCENT) { // %-comment
          do {
            ++position;
            if (position >= length) {
              break;
            }
            ch = buffer[position];
          } while (ch !== LF && ch !== CR);
          continue;
        }
        var token = readToken(buffer, position);
        var m;
        if (token.startsWith('xref') &&
            (token.length === 4 || /\s/.test(token[4]))) {
          position += skipUntil(buffer, position, trailerBytes);
          trailers.push(position);
          position += skipUntil(buffer, position, startxrefBytes);
        } else if ((m = objRegExp.exec(token))) {
          if (typeof this.entries[m[1]] === 'undefined') {
            this.entries[m[1]] = {
              offset: position - stream.start,
              gen: m[2] | 0,
              uncompressed: true,
            };
          }
          let contentLength, startPos = position + token.length;

          // Find the next "obj" string, rather than "endobj", to ensure that
          // we won't skip over a new 'obj' operator in corrupt files where
          // 'endobj' operators are missing (fixes issue9105_reduced.pdf).
          while (startPos < buffer.length) {
            let endPos = startPos + skipUntil(buffer, startPos, objBytes) + 4;
            contentLength = endPos - position;

            let checkPos = Math.max(endPos - CHECK_CONTENT_LENGTH, startPos);
            let tokenStr = bytesToString(buffer.subarray(checkPos, endPos));

            // Check if the current object ends with an 'endobj' operator.
            if (endobjRegExp.test(tokenStr)) {
              break;
            } else {
              // Check if an "obj" occurrence is actually a new object,
              // i.e. the current object is missing the 'endobj' operator.
              let objToken = nestedObjRegExp.exec(tokenStr);

              if (objToken && objToken[1]) {
                warn('indexObjects: Found new "obj" inside of another "obj", ' +
                     'caused by missing "endobj" -- trying to recover.');
                contentLength -= objToken[1].length;
                break;
              }
            }
            startPos = endPos;
          }
          let content = buffer.subarray(position, position + contentLength);

          // checking XRef stream suspect
          // (it shall have '/XRef' and next char is not a letter)
          var xrefTagOffset = skipUntil(content, 0, xrefBytes);
          if (xrefTagOffset < contentLength &&
              content[xrefTagOffset + 5] < 64) {
            xrefStms.push(position - stream.start);
            this.xrefstms[position - stream.start] = 1; // Avoid recursion
          }

          position += contentLength;
        } else if (token.startsWith('trailer') &&
                   (token.length === 7 || /\s/.test(token[7]))) {
          trailers.push(position);
          position += skipUntil(buffer, position, startxrefBytes);
        } else {
          position += token.length + 1;
        }
      }
      // reading XRef streams
      var i, ii;
      for (i = 0, ii = xrefStms.length; i < ii; ++i) {
        this.startXRefQueue.push(xrefStms[i]);
        this.readXRef(/* recoveryMode */ true);
      }
      // finding main trailer
      let trailerDict;
      for (i = 0, ii = trailers.length; i < ii; ++i) {
        stream.pos = trailers[i];
        var parser = new Parser(new Lexer(stream), /* allowStreams = */ true,
                                /* xref = */ this, /* recoveryMode = */ true);
        var obj = parser.getObj();
        if (!isCmd(obj, 'trailer')) {
          continue;
        }
        // read the trailer dictionary
        let dict = parser.getObj();
        if (!isDict(dict)) {
          continue;
        }
        // Do some basic validation of the trailer/root dictionary candidate.
        let rootDict;
        try {
          rootDict = dict.get('Root');
        } catch (ex) {
          if (ex instanceof MissingDataException) {
            throw ex;
          }
          continue;
        }
        if (!isDict(rootDict) || !rootDict.has('Pages')) {
          continue;
        }
        // taking the first one with 'ID'
        if (dict.has('ID')) {
          return dict;
        }
        // The current dictionary is a candidate, but continue searching.
        trailerDict = dict;
      }
      // No trailer with 'ID', taking last one (if exists).
      if (trailerDict) {
        return trailerDict;
      }
      // nothing helps
      throw new InvalidPDFException('Invalid PDF structure');
    },

    readXRef: function XRef_readXRef(recoveryMode) {
      var stream = this.stream;
      // Keep track of already parsed XRef tables, to prevent an infinite loop
      // when parsing corrupt PDF files where e.g. the /Prev entries create a
      // circular dependency between tables (fixes bug1393476.pdf).
      let startXRefParsedCache = Object.create(null);

      try {
        while (this.startXRefQueue.length) {
          var startXRef = this.startXRefQueue[0];

          if (startXRefParsedCache[startXRef]) {
            warn('readXRef - skipping XRef table since it was already parsed.');
            this.startXRefQueue.shift();
            continue;
          }
          startXRefParsedCache[startXRef] = true;

          stream.pos = startXRef + stream.start;

          var parser = new Parser(new Lexer(stream), true, this);
          var obj = parser.getObj();
          var dict;

          // Get dictionary
          if (isCmd(obj, 'xref')) {
            // Parse end-of-file XRef
            dict = this.processXRefTable(parser);
            if (!this.topDict) {
              this.topDict = dict;
            }

            // Recursively get other XRefs 'XRefStm', if any
            obj = dict.get('XRefStm');
            if (Number.isInteger(obj)) {
              var pos = obj;
              // ignore previously loaded xref streams
              // (possible infinite recursion)
              if (!(pos in this.xrefstms)) {
                this.xrefstms[pos] = 1;
                this.startXRefQueue.push(pos);
              }
            }
          } else if (Number.isInteger(obj)) {
            // Parse in-stream XRef
            if (!Number.isInteger(parser.getObj()) ||
                !isCmd(parser.getObj(), 'obj') ||
                !isStream(obj = parser.getObj())) {
              throw new FormatError('Invalid XRef stream');
            }
            dict = this.processXRefStream(obj);
            if (!this.topDict) {
              this.topDict = dict;
            }
            if (!dict) {
              throw new FormatError('Failed to read XRef stream');
            }
          } else {
            throw new FormatError('Invalid XRef stream header');
          }

          // Recursively get previous dictionary, if any
          obj = dict.get('Prev');
          if (Number.isInteger(obj)) {
            this.startXRefQueue.push(obj);
          } else if (isRef(obj)) {
            // The spec says Prev must not be a reference, i.e. "/Prev NNN"
            // This is a fallback for non-compliant PDFs, i.e. "/Prev NNN 0 R"
            this.startXRefQueue.push(obj.num);
          }

          this.startXRefQueue.shift();
        }

        return this.topDict;
      } catch (e) {
        if (e instanceof MissingDataException) {
          throw e;
        }
        info('(while reading XRef): ' + e);
      }

      if (recoveryMode) {
        return;
      }
      throw new XRefParseException();
    },

    getEntry: function XRef_getEntry(i) {
      var xrefEntry = this.entries[i];
      if (xrefEntry && !xrefEntry.free && xrefEntry.offset) {
        return xrefEntry;
      }
      return null;
    },

    fetchIfRef: function XRef_fetchIfRef(obj, suppressEncryption) {
      if (!isRef(obj)) {
        return obj;
      }
      return this.fetch(obj, suppressEncryption);
    },

    fetch: function XRef_fetch(ref, suppressEncryption) {
      if (!isRef(ref)) {
        throw new Error('ref object is not a reference');
      }
      var num = ref.num;
      if (num in this.cache) {
        var cacheEntry = this.cache[num];
        // In documents with Object Streams, it's possible that cached `Dict`s
        // have not been assigned an `objId` yet (see e.g. issue3115r.pdf).
        if (cacheEntry instanceof Dict && !cacheEntry.objId) {
          cacheEntry.objId = ref.toString();
        }
        return cacheEntry;
      }

      var xrefEntry = this.getEntry(num);

      // the referenced entry can be free
      if (xrefEntry === null) {
        return (this.cache[num] = null);
      }

      if (xrefEntry.uncompressed) {
        xrefEntry = this.fetchUncompressed(ref, xrefEntry, suppressEncryption);
      } else {
        xrefEntry = this.fetchCompressed(ref, xrefEntry, suppressEncryption);
      }
      if (isDict(xrefEntry)) {
        xrefEntry.objId = ref.toString();
      } else if (isStream(xrefEntry)) {
        xrefEntry.dict.objId = ref.toString();
      }
      return xrefEntry;
    },

    fetchUncompressed(ref, xrefEntry, suppressEncryption = false) {
      var gen = ref.gen;
      var num = ref.num;
      if (xrefEntry.gen !== gen) {
        throw new XRefEntryException(`Inconsistent generation in XRef: ${ref}`);
      }
      var stream = this.stream.makeSubStream(xrefEntry.offset +
                                             this.stream.start);
      var parser = new Parser(new Lexer(stream), true, this);
      var obj1 = parser.getObj();
      var obj2 = parser.getObj();
      var obj3 = parser.getObj();

      if (!Number.isInteger(obj1)) {
        obj1 = parseInt(obj1, 10);
      }
      if (!Number.isInteger(obj2)) {
        obj2 = parseInt(obj2, 10);
      }
      if (obj1 !== num || obj2 !== gen || !isCmd(obj3)) {
        throw new XRefEntryException(`Bad (uncompressed) XRef entry: ${ref}`);
      }
      if (obj3.cmd !== 'obj') {
        // some bad PDFs use "obj1234" and really mean 1234
        if (obj3.cmd.startsWith('obj')) {
          num = parseInt(obj3.cmd.substring(3), 10);
          if (!Number.isNaN(num)) {
            return num;
          }
        }
        throw new XRefEntryException(`Bad (uncompressed) XRef entry: ${ref}`);
      }
      if (this.encrypt && !suppressEncryption) {
        xrefEntry = parser.getObj(this.encrypt.createCipherTransform(num, gen));
      } else {
        xrefEntry = parser.getObj();
      }
      if (!isStream(xrefEntry)) {
        this.cache[num] = xrefEntry;
      }
      return xrefEntry;
    },

    fetchCompressed(ref, xrefEntry, suppressEncryption = false) {
      var tableOffset = xrefEntry.offset;
      var stream = this.fetch(new Ref(tableOffset, 0));
      if (!isStream(stream)) {
        throw new FormatError('bad ObjStm stream');
      }
      var first = stream.dict.get('First');
      var n = stream.dict.get('N');
      if (!Number.isInteger(first) || !Number.isInteger(n)) {
        throw new FormatError(
          'invalid first and n parameters for ObjStm stream');
      }
      var parser = new Parser(new Lexer(stream), false, this);
      parser.allowStreams = true;
      var i, entries = [], num, nums = [];
      // read the object numbers to populate cache
      for (i = 0; i < n; ++i) {
        num = parser.getObj();
        if (!Number.isInteger(num)) {
          throw new FormatError(
            `invalid object number in the ObjStm stream: ${num}`);
        }
        nums.push(num);
        var offset = parser.getObj();
        if (!Number.isInteger(offset)) {
          throw new FormatError(
            `invalid object offset in the ObjStm stream: ${offset}`);
        }
      }
      // read stream objects for cache
      for (i = 0; i < n; ++i) {
        entries.push(parser.getObj());
        // The ObjStm should not contain 'endobj'. If it's present, skip over it
        // to support corrupt PDFs (fixes issue 5241, bug 898610, bug 1037816).
        if (isCmd(parser.buf1, 'endobj')) {
          parser.shift();
        }
        num = nums[i];
        var entry = this.entries[num];
        if (entry && entry.offset === tableOffset && entry.gen === i) {
          this.cache[num] = entries[i];
        }
      }
      xrefEntry = entries[xrefEntry.gen];
      if (xrefEntry === undefined) {
        throw new XRefEntryException(`Bad (compressed) XRef entry: ${ref}`);
      }
      return xrefEntry;
    },

    async fetchIfRefAsync(obj, suppressEncryption) {
      if (!isRef(obj)) {
        return obj;
      }
      return this.fetchAsync(obj, suppressEncryption);
    },

    async fetchAsync(ref, suppressEncryption) {
      try {
        return this.fetch(ref, suppressEncryption);
      } catch (ex) {
        if (!(ex instanceof MissingDataException)) {
          throw ex;
        }
        await this.pdfManager.requestRange(ex.begin, ex.end);
        return this.fetchAsync(ref, suppressEncryption);
      }
    },

    getCatalogObj: function XRef_getCatalogObj() {
      return this.root;
    },
  };

  return XRef;
})();

/**
 * A NameTree/NumberTree is like a Dict but has some advantageous properties,
 * see the specification (7.9.6 and 7.9.7) for additional details.
 * TODO: implement all the Dict functions and make this more efficient.
 */
class NameOrNumberTree {
  constructor(root, xref, type) {
    if (this.constructor === NameOrNumberTree) {
      unreachable('Cannot initialize NameOrNumberTree.');
    }
    this.root = root;
    this.xref = xref;
    this._type = type;
  }

  getAll() {
    const dict = Object.create(null);
    if (!this.root) {
      return dict;
    }
    const xref = this.xref;
    // Reading Name/Number tree.
    const processed = new RefSet();
    processed.put(this.root);
    const queue = [this.root];
    while (queue.length > 0) {
      const obj = xref.fetchIfRef(queue.shift());
      if (!isDict(obj)) {
        continue;
      }
      if (obj.has('Kids')) {
        const kids = obj.get('Kids');
        for (let i = 0, ii = kids.length; i < ii; i++) {
          const kid = kids[i];
          if (processed.has(kid)) {
            throw new FormatError(`Duplicate entry in "${this._type}" tree.`);
          }
          queue.push(kid);
          processed.put(kid);
        }
        continue;
      }
      const entries = obj.get(this._type);
      if (Array.isArray(entries)) {
        for (let i = 0, ii = entries.length; i < ii; i += 2) {
          dict[xref.fetchIfRef(entries[i])] = xref.fetchIfRef(entries[i + 1]);
        }
      }
    }
    return dict;
  }

  get(key) {
    if (!this.root) {
      return null;
    }
    const xref = this.xref;
    let kidsOrEntries = xref.fetchIfRef(this.root);
    let loopCount = 0;
    const MAX_LEVELS = 10;

    // Perform a binary search to quickly find the entry that
    // contains the key we are looking for.
    while (kidsOrEntries.has('Kids')) {
      if (++loopCount > MAX_LEVELS) {
        warn(`Search depth limit reached for "${this._type}" tree.`);
        return null;
      }

      const kids = kidsOrEntries.get('Kids');
      if (!Array.isArray(kids)) {
        return null;
      }

      let l = 0, r = kids.length - 1;
      while (l <= r) {
        const m = (l + r) >> 1;
        const kid = xref.fetchIfRef(kids[m]);
        const limits = kid.get('Limits');

        if (key < xref.fetchIfRef(limits[0])) {
          r = m - 1;
        } else if (key > xref.fetchIfRef(limits[1])) {
          l = m + 1;
        } else {
          kidsOrEntries = xref.fetchIfRef(kids[m]);
          break;
        }
      }
      if (l > r) {
        return null;
      }
    }

    // If we get here, then we have found the right entry. Now go through the
    // entries in the dictionary until we find the key we're looking for.
    const entries = kidsOrEntries.get(this._type);
    if (Array.isArray(entries)) {
      // Perform a binary search to reduce the lookup time.
      let l = 0, r = entries.length - 2;
      while (l <= r) {
        // Check only even indices (0, 2, 4, ...) because the
        // odd indices contain the actual data.
        const tmp = (l + r) >> 1, m = tmp + (tmp & 1);
        const currentKey = xref.fetchIfRef(entries[m]);
        if (key < currentKey) {
          r = m - 2;
        } else if (key > currentKey) {
          l = m + 2;
        } else {
          return xref.fetchIfRef(entries[m + 1]);
        }
      }

      // Fallback to an exhaustive search, in an attempt to handle corrupt
      // PDF files where keys are not correctly ordered (fixes issue 10272).
      info(`Falling back to an exhaustive search, for key "${key}", ` +
           `in "${this._type}" tree.`);
      for (let m = 0, mm = entries.length; m < mm; m += 2) {
        const currentKey = xref.fetchIfRef(entries[m]);
        if (currentKey === key) {
          warn(`The "${key}" key was found at an incorrect, ` +
               `i.e. out-of-order, position in "${this._type}" tree.`);
          return xref.fetchIfRef(entries[m + 1]);
        }
      }
    }
    return null;
  }
}

class NameTree extends NameOrNumberTree {
  constructor(root, xref) {
    super(root, xref, 'Names');
  }
}

class NumberTree extends NameOrNumberTree {
  constructor(root, xref) {
    super(root, xref, 'Nums');
  }
}

/**
 * "A PDF file can refer to the contents of another file by using a File
 * Specification (PDF 1.1)", see the spec (7.11) for more details.
 * NOTE: Only embedded files are supported (as part of the attachments support)
 * TODO: support the 'URL' file system (with caching if !/V), portable
 * collections attributes and related files (/RF)
 */
var FileSpec = (function FileSpecClosure() {
  function FileSpec(root, xref) {
    if (!root || !isDict(root)) {
      return;
    }
    this.xref = xref;
    this.root = root;
    if (root.has('FS')) {
      this.fs = root.get('FS');
    }
    this.description = root.has('Desc') ?
                         stringToPDFString(root.get('Desc')) :
                         '';
    if (root.has('RF')) {
      warn('Related file specifications are not supported');
    }
    this.contentAvailable = true;
    if (!root.has('EF')) {
      this.contentAvailable = false;
      warn('Non-embedded file specifications are not supported');
    }
  }

  function pickPlatformItem(dict) {
    // Look for the filename in this order:
    // UF, F, Unix, Mac, DOS
    if (dict.has('UF')) {
      return dict.get('UF');
    } else if (dict.has('F')) {
      return dict.get('F');
    } else if (dict.has('Unix')) {
      return dict.get('Unix');
    } else if (dict.has('Mac')) {
      return dict.get('Mac');
    } else if (dict.has('DOS')) {
      return dict.get('DOS');
    }
    return null;
  }

  FileSpec.prototype = {
    get filename() {
      if (!this._filename && this.root) {
        var filename = pickPlatformItem(this.root) || 'unnamed';
        this._filename = stringToPDFString(filename).
          replace(/\\\\/g, '\\').
          replace(/\\\//g, '/').
          replace(/\\/g, '/');
      }
      return this._filename;
    },
    get content() {
      if (!this.contentAvailable) {
        return null;
      }
      if (!this.contentRef && this.root) {
        this.contentRef = pickPlatformItem(this.root.get('EF'));
      }
      var content = null;
      if (this.contentRef) {
        var xref = this.xref;
        var fileObj = xref.fetchIfRef(this.contentRef);
        if (fileObj && isStream(fileObj)) {
          content = fileObj.getBytes();
        } else {
          warn('Embedded file specification points to non-existing/invalid ' +
            'content');
        }
      } else {
        warn('Embedded file specification does not have a content');
      }
      return content;
    },
    get serializable() {
      return {
        filename: this.filename,
        content: this.content,
      };
    },
  };
  return FileSpec;
})();

/**
 * A helper for loading missing data in `Dict` graphs. It traverses the graph
 * depth first and queues up any objects that have missing data. Once it has
 * has traversed as many objects that are available it attempts to bundle the
 * missing data requests and then resume from the nodes that weren't ready.
 *
 * NOTE: It provides protection from circular references by keeping track of
 * loaded references. However, you must be careful not to load any graphs
 * that have references to the catalog or other pages since that will cause the
 * entire PDF document object graph to be traversed.
 */
let ObjectLoader = (function() {
  function mayHaveChildren(value) {
    return isRef(value) || isDict(value) || Array.isArray(value) ||
           isStream(value);
  }

  function addChildren(node, nodesToVisit) {
    if (isDict(node) || isStream(node)) {
      let dict = isDict(node) ? node : node.dict;
      let dictKeys = dict.getKeys();
      for (let i = 0, ii = dictKeys.length; i < ii; i++) {
        let rawValue = dict.getRaw(dictKeys[i]);
        if (mayHaveChildren(rawValue)) {
          nodesToVisit.push(rawValue);
        }
      }
    } else if (Array.isArray(node)) {
      for (let i = 0, ii = node.length; i < ii; i++) {
        let value = node[i];
        if (mayHaveChildren(value)) {
          nodesToVisit.push(value);
        }
      }
    }
  }

  function ObjectLoader(dict, keys, xref) {
    this.dict = dict;
    this.keys = keys;
    this.xref = xref;
    this.refSet = null;
    this.capability = null;
  }

  ObjectLoader.prototype = {
    load() {
      this.capability = createPromiseCapability();
      // Don't walk the graph if all the data is already loaded.
      if (!(this.xref.stream instanceof ChunkedStream) ||
          this.xref.stream.getMissingChunks().length === 0) {
        this.capability.resolve();
        return this.capability.promise;
      }

      let { keys, dict, } = this;
      this.refSet = new RefSet();
      // Setup the initial nodes to visit.
      let nodesToVisit = [];
      for (let i = 0, ii = keys.length; i < ii; i++) {
        let rawValue = dict.getRaw(keys[i]);
        // Skip nodes that are guaranteed to be empty.
        if (rawValue !== undefined) {
          nodesToVisit.push(rawValue);
        }
      }

      this._walk(nodesToVisit);
      return this.capability.promise;
    },

    _walk(nodesToVisit) {
      let nodesToRevisit = [];
      let pendingRequests = [];
      // DFS walk of the object graph.
      while (nodesToVisit.length) {
        let currentNode = nodesToVisit.pop();

        // Only references or chunked streams can cause missing data exceptions.
        if (isRef(currentNode)) {
          // Skip nodes that have already been visited.
          if (this.refSet.has(currentNode)) {
            continue;
          }
          try {
            this.refSet.put(currentNode);
            currentNode = this.xref.fetch(currentNode);
          } catch (ex) {
            if (!(ex instanceof MissingDataException)) {
              throw ex;
            }
            nodesToRevisit.push(currentNode);
            pendingRequests.push({ begin: ex.begin, end: ex.end, });
          }
        }
        if (currentNode && currentNode.getBaseStreams) {
          let baseStreams = currentNode.getBaseStreams();
          let foundMissingData = false;
          for (let i = 0, ii = baseStreams.length; i < ii; i++) {
            let stream = baseStreams[i];
            if (stream.getMissingChunks && stream.getMissingChunks().length) {
              foundMissingData = true;
              pendingRequests.push({ begin: stream.start, end: stream.end, });
            }
          }
          if (foundMissingData) {
            nodesToRevisit.push(currentNode);
          }
        }

        addChildren(currentNode, nodesToVisit);
      }

      if (pendingRequests.length) {
        this.xref.stream.manager.requestRanges(pendingRequests).then(() => {
          for (let i = 0, ii = nodesToRevisit.length; i < ii; i++) {
            let node = nodesToRevisit[i];
            // Remove any reference nodes from the current `RefSet` so they
            // aren't skipped when we revist them.
            if (isRef(node)) {
              this.refSet.remove(node);
            }
          }
          this._walk(nodesToRevisit);
        }, this.capability.reject);
        return;
      }
      // Everything is loaded.
      this.refSet = null;
      this.capability.resolve();
    },
  };

  return ObjectLoader;
})();

export {
  Catalog,
  ObjectLoader,
  XRef,
  FileSpec,
};
