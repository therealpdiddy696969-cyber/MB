"use strict";

(() => {
    var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
    var TomlDate = class _TomlDate extends Date {
        #hasDate=false;
        #hasTime=false;
        #offset=null;
        constructor(date) {
            let hasDate = true;
            let hasTime = true;
            let offset = "Z";
            if (typeof date === "string") {
                let match = date.match(DATE_TIME_RE);
                if (match) {
                    if (!match[1]) {
                        hasDate = false;
                        date = `0000-01-01T${date}`;
                    }
                    hasTime = !!match[2];
                    hasTime && date[10] === " " && (date = date.replace(" ", "T"));
                    if (match[2] && +match[2] > 23) {
                        date = "";
                    } else {
                        offset = match[3] || null;
                        date = date.toUpperCase();
                        if (!offset && hasTime) date += "Z";
                    }
                } else {
                    date = "";
                }
            }
            super(date);
            if (!isNaN(this.getTime())) {
                this.#hasDate = hasDate;
                this.#hasTime = hasTime;
                this.#offset = offset;
            }
        }
        isDateTime() {
            return this.#hasDate && this.#hasTime;
        }
        isLocal() {
            return !this.#hasDate || !this.#hasTime || !this.#offset;
        }
        isDate() {
            return this.#hasDate && !this.#hasTime;
        }
        isTime() {
            return this.#hasTime && !this.#hasDate;
        }
        isValid() {
            return this.#hasDate || this.#hasTime;
        }
        toISOString() {
            let iso = super.toISOString();
            if (this.isDate()) return iso.slice(0, 10);
            if (this.isTime()) return iso.slice(11, 23);
            if (this.#offset === null) return iso.slice(0, -1);
            if (this.#offset === "Z") return iso;
            let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
            offset = this.#offset[0] === "-" ? offset : -offset;
            let offsetDate = new Date(this.getTime() - offset * 6e4);
            return offsetDate.toISOString().slice(0, -1) + this.#offset;
        }
        static wrapAsOffsetDateTime(jsDate, offset = "Z") {
            let date = new _TomlDate(jsDate);
            date.#offset = offset;
            return date;
        }
        static wrapAsLocalDateTime(jsDate) {
            let date = new _TomlDate(jsDate);
            date.#offset = null;
            return date;
        }
        static wrapAsLocalDate(jsDate) {
            let date = new _TomlDate(jsDate);
            date.#hasTime = false;
            date.#offset = null;
            return date;
        }
        static wrapAsLocalTime(jsDate) {
            let date = new _TomlDate(jsDate);
            date.#hasDate = false;
            date.#offset = null;
            return date;
        }
    };
    function getLineColFromPtr(string, ptr) {
        let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
        return [ lines.length, lines.pop().length + 1 ];
    }
    function makeCodeBlock(string, line, column) {
        let lines = string.split(/\r\n|\n|\r/g);
        let codeblock = "";
        let numberLen = (Math.log10(line + 1) | 0) + 1;
        for (let i = line - 1; i <= line + 1; i++) {
            let l = lines[i - 1];
            if (!l) continue;
            codeblock += i.toString().padEnd(numberLen, " ");
            codeblock += ":  ";
            codeblock += l;
            codeblock += "\n";
            if (i === line) {
                codeblock += " ".repeat(numberLen + column + 2);
                codeblock += "^\n";
            }
        }
        return codeblock;
    }
    var TomlError = class extends Error {
        line;
        column;
        codeblock;
        constructor(message, options) {
            const [line, column] = getLineColFromPtr(options.toml, options.ptr);
            const codeblock = makeCodeBlock(options.toml, line, column);
            super(`Invalid TOML document: ${message}\n\n${codeblock}`, options);
            this.line = line;
            this.column = column;
            this.codeblock = codeblock;
        }
    };
    function indexOfNewline(str, start = 0) {
        let idx = str.indexOf("\n", start);
        if (str.charCodeAt(idx - 1) === 13) idx--;
        return idx;
    }
    function skipComment(ctx) {
        for (;ctx.p < ctx.s.length; ctx.p++) {
            let c = ctx.s.charCodeAt(ctx.p);
            if (c === 10) break;
            if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
                ctx.p++;
                break;
            }
            if (c < 32 && c !== 9 || c === 127) {
                throw new TomlError("control characters are not allowed in comments", {
                    toml: ctx.s,
                    ptr: ctx.p
                });
            }
        }
    }
    function skipVoid(ctx, banNewLines, banComments) {
        let c;
        while (1) {
            while ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) ctx.p++;
            if (banComments || c !== 35) break;
            skipComment(ctx);
        }
    }
    function skipUntil(ctx, sep, end) {
        let ptr = ctx.p;
        if (!end) {
            ptr = indexOfNewline(ctx.s, ptr);
            ctx.p = ptr < 0 ? ctx.s.length : ptr;
            return;
        }
        for (;ctx.p < ctx.s.length; ctx.p++) {
            let c = ctx.s.charCodeAt(ctx.p);
            if (c === 35) {
                skipComment(ctx);
            } else if (c === end || c === sep) {
                return;
            }
        }
        throw new TomlError("cannot find end of structure", {
            toml: ctx.s,
            ptr: ptr
        });
    }
    var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
    var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
    var LEADING_ZERO = /^[+-]?0[0-9_]/;
    function parseString(ctx) {
        let start = ctx.p;
        let c = ctx.s.charCodeAt(ctx.p++);
        let first = c;
        let isLiteral = c === 39;
        let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
        if (isMultiline) {
            if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10) ctx.p++; else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) ctx.p += 2;
        }
        let parsed = "";
        let sliceStart = ctx.p;
        let state = 0;
        for (;ctx.p < ctx.s.length; ctx.p++) {
            c = ctx.s.charCodeAt(ctx.p);
            if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
                state = state && 3;
            } else if (c < 32 && c !== 9 || c === 127) {
                throw new TomlError("control characters are not allowed in strings", {
                    toml: ctx.s,
                    ptr: ctx.p
                });
            } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
                if (isMultiline) {
                    if (ctx.s.charCodeAt(ctx.p + 3) === first) ctx.p++;
                    if (ctx.s.charCodeAt(ctx.p + 3) === first) ctx.p++;
                }
                if (!state) parsed += ctx.s.slice(sliceStart, ctx.p);
                ctx.p += isMultiline ? 3 : 1;
                return parsed;
            } else if (!state) {
                if (!isLiteral && c === 92) {
                    parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
                    state = 1;
                }
            } else if (state === 1) {
                if (c === 120 || c === 117 || c === 85) {
                    let value = 0;
                    let len = c === 120 ? 2 : c === 117 ? 4 : 8;
                    for (let j = 0; j < len; j++, ctx.p++) {
                        let hex = ctx.s.charCodeAt(ctx.p + 1);
                        let digit = hex >= 48 && hex <= 57 ? hex - 48 : hex >= 65 && hex <= 70 ? hex - 65 + 10 : hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1;
                        if (digit < 0) throw new TomlError("invalid non-hex character in unicode escape", {
                            toml: ctx.s,
                            ptr: ctx.p + 1
                        });
                        value = value << 4 | digit;
                    }
                    if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
                        throw new TomlError("invalid unicode escape", {
                            toml: ctx.s,
                            ptr: ctx.p
                        });
                    }
                    parsed += String.fromCodePoint(value);
                    sliceStart = ctx.p + 1;
                    state = 0;
                } else if (c === 32 || c === 9) {
                    state = 2;
                } else {
                    if (c === 98) parsed += "\b"; else if (c === 116) parsed += "\t"; else if (c === 110) parsed += "\n"; else if (c === 102) parsed += "\f"; else if (c === 114) parsed += "\r"; else if (c === 101) parsed += ""; else if (c === 34) parsed += '"'; else if (c === 92) parsed += "\\"; else throw new TomlError("unrecognized escape sequence", {
                        toml: ctx.s,
                        ptr: ctx.p
                    });
                    sliceStart = ctx.p + 1;
                    state = 0;
                }
            } else if (c !== 32 && c !== 9) {
                if (state === 2) {
                    throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
                        toml: ctx.s,
                        ptr: sliceStart
                    });
                }
                state = !isLiteral && c === 92 ? 1 : 0;
                sliceStart = ctx.p;
            }
        }
        throw new TomlError("unfinished string", {
            toml: ctx.s,
            ptr: start
        });
    }
    function sliceAndTrimEndOf(ctx, start, end) {
        let value = ctx.s.slice(start, end);
        let commentIdx = value.indexOf("#");
        if (commentIdx > 0) {
            skipComment({
                s: value,
                p: commentIdx,
                d: 0
            });
            value = value.slice(0, commentIdx);
        }
        return value.trimEnd();
    }
    function parseValue(ctx, integersAsBigInt, end) {
        let ptr = ctx.p;
        let err = {
            toml: ctx.s,
            ptr: ptr
        };
        skipUntil(ctx, 44, end);
        let value = sliceAndTrimEndOf(ctx, ptr, ctx.p);
        if (!value) throw new TomlError("incomplete declaration: value expected", err);
        if (value === "-inf") return -Infinity;
        if (value === "inf" || value === "+inf") return Infinity;
        if (value === "nan" || value === "+nan" || value === "-nan") return NaN;
        if (value === "-0") return integersAsBigInt ? 0n : 0;
        let isInt = INT_REGEX.test(value);
        if (isInt || FLOAT_REGEX.test(value)) {
            if (LEADING_ZERO.test(value)) {
                throw new TomlError("leading zeroes are not allowed", err);
            }
            value = value.replace(/_/g, "");
            let numeric = +value;
            if (isNaN(numeric)) {
                throw new TomlError("invalid number", err);
            }
            if (isInt) {
                if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
                    throw new TomlError("integer value cannot be represented losslessly", err);
                }
                if (isInt || integersAsBigInt === true) numeric = BigInt(value);
            }
            return numeric;
        }
        const date = new TomlDate(value);
        if (!date.isValid()) throw new TomlError("invalid value", err);
        return date;
    }
    function extractValue(ctx, end, integersAsBigInt) {
        let ptr = ctx.p;
        let c = ctx.s.charCodeAt(ptr);
        if (c === 91 || c === 123) {
            if (!ctx.d--) {
                throw new TomlError("document contains excessively nested structures. aborting.", {
                    toml: ctx.s,
                    ptr: ptr
                });
            }
            let value = c === 91 ? parseArray(ctx, integersAsBigInt) : parseInlineTable(ctx, integersAsBigInt);
            ctx.d++;
            return value;
        }
        if (c === 34 || c === 39) {
            return parseString(ctx);
        }
        if (c === 116) {
            if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101) throw new TomlError("invalid value", {
                toml: ctx.s,
                ptr: ptr
            });
            ctx.p++;
            return true;
        }
        if (c === 102) {
            if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101) throw new TomlError("invalid value", {
                toml: ctx.s,
                ptr: ptr
            });
            ctx.p++;
            return false;
        }
        return parseValue(ctx, integersAsBigInt, end);
    }
    var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
    function parseKey(ctx, end = "=") {
        let start = ctx.p;
        let dot = start - 1;
        let parsed = [];
        let endPtr = ctx.s.indexOf(end, start);
        if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
                toml: ctx.s,
                ptr: start
            });
        }
        do {
            let c = ctx.s.charCodeAt(ctx.p = ++dot);
            if (c !== 32 && c !== 9) {
                if (c === 34 || c === 39) {
                    if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) {
                        throw new TomlError("multiline strings are not allowed in keys", {
                            toml: ctx.s,
                            ptr: ctx.p
                        });
                    }
                    let part = parseString(ctx);
                    dot = ctx.s.indexOf(".", ctx.p);
                    let strEnd = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
                    let newLine = indexOfNewline(strEnd);
                    if (newLine > -1) {
                        throw new TomlError("newlines are not allowed in keys", {
                            toml: ctx.s,
                            ptr: newLine
                        });
                    }
                    if (strEnd.trimStart()) {
                        throw new TomlError("found extra tokens after the string part", {
                            toml: ctx.s,
                            ptr: ctx.p
                        });
                    }
                    if (endPtr < ctx.p) {
                        endPtr = ctx.s.indexOf(end, ctx.p);
                        if (endPtr < 0) {
                            throw new TomlError("incomplete key-value: cannot find end of key", {
                                toml: ctx.s,
                                ptr: start
                            });
                        }
                    }
                    parsed.push(part);
                } else {
                    dot = ctx.s.indexOf(".", ctx.p);
                    let part = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
                    if (!KEY_PART_RE.test(part)) {
                        throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
                            toml: ctx.s,
                            ptr: ctx.p
                        });
                    }
                    parsed.push(part.trimEnd());
                }
            }
        } while (dot + 1 && dot < endPtr);
        ctx.p = endPtr + 1;
        skipVoid(ctx, true, true);
        return parsed;
    }
    function parseInlineTable(ctx, integersAsBigInt) {
        let res = {};
        let seen = new Set;
        let c;
        ctx.p++;
        while (ctx.p < ctx.s.length) {
            skipVoid(ctx);
            if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
                ctx.p++;
                return res;
            }
            let k;
            let t = res;
            let hasOwn = false;
            let p = ctx.p;
            let key = parseKey(ctx);
            for (let i = 0; i < key.length; i++) {
                if (i) t = hasOwn ? t[k] : t[k] = {};
                k = key[i];
                if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
                    throw new TomlError("trying to redefine an already defined value", {
                        toml: ctx.s,
                        ptr: p
                    });
                }
                if (!hasOwn && k === "__proto__") {
                    Object.defineProperty(t, k, {
                        enumerable: true,
                        configurable: true,
                        writable: true
                    });
                }
            }
            if (hasOwn) {
                throw new TomlError("trying to redefine an already defined value", {
                    toml: ctx.s,
                    ptr: ctx.p
                });
            }
            let value = extractValue(ctx, 125, integersAsBigInt);
            seen.add(t[k] = value);
            skipVoid(ctx);
            if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
                return res;
            }
            if (c !== 44) {
                throw new TomlError("expected comma or end of structure", {
                    toml: ctx.s,
                    ptr: ctx.p - 1
                });
            }
        }
        throw new TomlError("unfinished table encountered", {
            toml: ctx.s,
            ptr: ctx.p
        });
    }
    function parseArray(ctx, integersAsBigInt) {
        let res = [];
        let c;
        ctx.p++;
        while (ctx.p < ctx.s.length) {
            skipVoid(ctx);
            if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
                ctx.p++;
                return res;
            }
            res.push(extractValue(ctx, 93, integersAsBigInt));
            skipVoid(ctx);
            if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
                return res;
            }
            if (c !== 44) {
                throw new TomlError("expected comma or end of structure", {
                    toml: ctx.s,
                    ptr: ctx.p - 1
                });
            }
        }
        throw new TomlError("unfinished array encountered", {
            toml: ctx.s,
            ptr: ctx.p
        });
    }
    function peekTable(key, table, meta, type) {
        let t = table;
        let m = meta;
        let k;
        let hasOwn = false;
        let state;
        for (let i = 0; i < key.length; i++) {
            if (i) {
                t = hasOwn ? t[k] : t[k] = {};
                m = (state = m[k]).c;
                if (type === 0 && (state.t === 1 || state.t === 2)) {
                    return null;
                }
                if (state.t === 2) {
                    let l = t.length - 1;
                    t = t[l];
                    m = m[l].c;
                }
            }
            k = key[i];
            if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
                return null;
            }
            if (!hasOwn) {
                if (k === "__proto__") {
                    Object.defineProperty(t, k, {
                        enumerable: true,
                        configurable: true,
                        writable: true
                    });
                    Object.defineProperty(m, k, {
                        enumerable: true,
                        configurable: true,
                        writable: true
                    });
                }
                m[k] = {
                    t: i < key.length - 1 && type === 2 ? 3 : type,
                    d: false,
                    i: 0,
                    c: {}
                };
            }
        }
        state = m[k];
        if (state.t !== type && !(type === 1 && state.t === 3)) {
            return null;
        }
        if (type === 2) {
            if (!state.d) {
                state.d = true;
                t[k] = [];
            }
            t[k].push(t = {});
            state.c[state.i++] = state = {
                t: 1,
                d: false,
                i: 0,
                c: {}
            };
        }
        if (state.d) {
            return null;
        }
        state.d = true;
        if (type === 1) {
            t = hasOwn ? t[k] : t[k] = {};
        } else if (type === 0 && hasOwn) {
            return null;
        }
        return [ k, t, state.c ];
    }
    function parse(toml, {maxDepth: maxDepth = 1e3, integersAsBigInt: integersAsBigInt} = {}) {
        let ctx = {
            s: toml,
            p: 0,
            d: maxDepth
        };
        let res = {};
        let meta = {};
        let tmp;
        let tbl = res;
        let m = meta;
        skipVoid(ctx);
        while (ctx.p < toml.length) {
            if (toml.charCodeAt(ctx.p) === 91) {
                let isTableArray = toml.charCodeAt(++ctx.p) === 91;
                tmp = ctx.p += +isTableArray;
                let k = parseKey(ctx, "]");
                if (isTableArray) {
                    if (toml.charCodeAt(ctx.p - 1) !== 93) {
                        throw new TomlError("expected end of table declaration", {
                            toml: toml,
                            ptr: ctx.p - 1
                        });
                    }
                    ctx.p++;
                }
                let p = peekTable(k, res, meta, isTableArray ? 2 : 1);
                if (!p) {
                    throw new TomlError("trying to redefine an already defined table or value", {
                        toml: toml,
                        ptr: tmp
                    });
                }
                m = p[2];
                tbl = p[1];
            } else {
                tmp = ctx.p;
                let k = parseKey(ctx);
                let p = peekTable(k, tbl, m, 0);
                if (!p) {
                    throw new TomlError("trying to redefine an already defined table or value", {
                        toml: toml,
                        ptr: tmp
                    });
                }
                p[1][p[0]] = extractValue(ctx, void 0, integersAsBigInt);
            }
            skipVoid(ctx, true);
            if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && tmp !== 13) {
                throw new TomlError("each key-value declaration must be followed by an end-of-line", {
                    toml: toml,
                    ptr: ctx.p
                });
            }
            skipVoid(ctx);
        }
        return res;
    }
    var MOD_DB_NAME = "balatro-web-mod-manager";
    var MOD_DB_VERSION = 2;
    var MODS_STORE = "mods";
    var ASSETS_STORE = "assets";
    var REPORTS_STORE = "launch-reports";
    var dbPromise = null;
    function openModDatabase() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request2 = indexedDB.open(MOD_DB_NAME, MOD_DB_VERSION);
            request2.onupgradeneeded = () => {
                const db = request2.result;
                if (!db.objectStoreNames.contains(MODS_STORE)) db.createObjectStore(MODS_STORE, {
                    keyPath: "id"
                });
                if (!db.objectStoreNames.contains(ASSETS_STORE)) db.createObjectStore(ASSETS_STORE, {
                    keyPath: "key"
                });
                if (!db.objectStoreNames.contains(REPORTS_STORE)) db.createObjectStore(REPORTS_STORE, {
                    keyPath: "id"
                });
            };
            request2.onsuccess = () => resolve(request2.result);
            request2.onerror = () => reject(request2.error ?? new Error("Unable to open browser mod storage."));
        });
        return dbPromise;
    }
    async function request(storeName, mode, operation) {
        const db = await openModDatabase();
        return new Promise((resolve, reject) => {
            const req = operation(db.transaction(storeName, mode).objectStore(storeName));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error(`Browser mod storage failed (${storeName}).`));
        });
    }
    var getMods = () => request(MODS_STORE, "readonly", store => store.getAll());
    var putMod = mod => request(MODS_STORE, "readwrite", store => store.put(mod));
    var getAssets = () => request(ASSETS_STORE, "readonly", store => store.getAll());
    var putAsset = asset => request(ASSETS_STORE, "readwrite", store => store.put(asset));
    var putLaunchReport = report => request(REPORTS_STORE, "readwrite", store => store.put(report));
    async function deleteMod(id) {
        await request(MODS_STORE, "readwrite", store => store.delete(id));
        const assets = await getAssets();
        for (const asset of assets.filter(item => item.modId === id)) {
            await request(ASSETS_STORE, "readwrite", store => store.delete(asset.key));
        }
        return true;
    }
    async function setModEnabled(id, enabled) {
        const mods = await getMods();
        const mod = mods.find(item => item.id === id);
        if (!mod) return null;
        mod.enabled = !!enabled;
        await putMod(mod);
        return mod;
    }
    var MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
    var MAX_EXPANDED_BYTES = 300 * 1024 * 1024;
    var MAX_FILES = 3e3;
    var MAX_TEXTURE_DIMENSION = 8192;
    var MAX_RAW_CACHE_BYTES_PER_MOD = 128 * 1024 * 1024;
    var IMAGE_PATTERN = /\.(?:png|jpe?g|webp|bmp)$/i;
    function cleanPath(raw) {
        const value = raw.replaceAll("\\", "/").replace(/^\.\//, "");
        if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some(part => part === "..")) {
            throw new Error(`Unsafe archive path rejected: ${raw}`);
        }
        return value.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
    }
    function archiveType(name, declared = "") {
        const value = `${declared} ${name}`.toLowerCase();
        if (/\.tar\.gz\b|\.tgz\b|gzip/.test(value)) return "tgz";
        if (/\.tar\b/.test(value)) return "tar";
        if (/\.zip\b|zip/.test(value)) return "zip";
        throw new Error("Only ZIP, TAR, TAR.GZ, and TGZ mod archives are supported.");
    }
    function readTar(bytes) {
        const decoder = new TextDecoder;
        const files = [];
        let offset = 0;
        let expanded = 0;
        while (offset + 512 <= bytes.length) {
            const header = bytes.subarray(offset, offset + 512);
            if (header.every(byte => byte === 0)) break;
            const field = (start, length) => decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/, "").trim();
            const name = `${field(345, 155)}${field(345, 155) ? "/" : ""}${field(0, 100)}`;
            const sizeText = field(124, 12).replace(/\0/g, "").trim();
            const size = Number.parseInt(sizeText || "0", 8);
            const type = field(156, 1) || "0";
            if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error("Malformed TAR archive.");
            if (type === "1" || type === "2") throw new Error("Archive links are not supported.");
            if (type === "0" && name) {
                const path = cleanPath(name);
                expanded += size;
                if (files.length + 1 > MAX_FILES || expanded > MAX_EXPANDED_BYTES) throw new Error("Archive exceeds browser decompression limits.");
                files.push({
                    path: path,
                    bytes: bytes.slice(offset + 512, offset + 512 + size)
                });
            }
            offset += 512 + Math.ceil(size / 512) * 512;
        }
        return files;
    }
    async function unpack(name, type, input) {
        if (input.byteLength > MAX_ARCHIVE_BYTES) throw new Error("Archive exceeds the 100 MB compressed-size limit.");
        const kind = archiveType(name, type);
        let files;
        if (kind === "zip") {
            const archive = await window.JSZip.loadAsync(input);
            files = [];
            let expanded = 0;
            for (const entry of Object.values(archive.files)) {
                if (entry.dir || /(^|\/)__MACOSX\//i.test(entry.name)) continue;
                const path = cleanPath(entry.name);
                const bytes = await entry.async("uint8array");
                expanded += bytes.byteLength;
                if (files.length + 1 > MAX_FILES || expanded > MAX_EXPANDED_BYTES) throw new Error("Archive exceeds browser decompression limits.");
                files.push({
                    path: path,
                    bytes: bytes
                });
            }
        } else {
            let tar = new Uint8Array(input);
            if (kind === "tgz") {
                if (!("DecompressionStream" in window)) throw new Error("This browser cannot decompress TGZ files.");
                const stream = new Blob([ input ]).stream().pipeThrough(new DecompressionStream("gzip"));
                tar = new Uint8Array(await new Response(stream).arrayBuffer());
                if (tar.byteLength > MAX_EXPANDED_BYTES) throw new Error("Archive exceeds browser decompression limits.");
            }
            files = readTar(tar);
        }
        if (!files.length) throw new Error("No mod files were found in this archive.");
        return {
            files: files,
            type: kind
        };
    }
    function commonWrapper(files) {
        if (files.some(file => !file.path.includes("/"))) return "";
        const roots = new Set(files.map(file => file.path.split("/")[0]));
        return roots.size === 1 ? `${Array.from(roots)[0]}/` : "";
    }
    function normalizedId(value, fallback) {
        const id = String(value ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
        return id || fallback;
    }
    function detectRoots(files, fallback) {
        const decoder = new TextDecoder;
        const roots = new Map;
        for (const file of files.filter(item => /\.json$/i.test(item.path))) {
            try {
                const manifest = JSON.parse(decoder.decode(file.bytes));
                const rawId = manifest.id ?? manifest.ID;
                if (!rawId || !(manifest.name || manifest.Name || manifest.main_file || manifest.prefix)) continue;
                const path = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
                const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [];
                roots.set(path, {
                    path: path,
                    id: normalizedId(rawId, fallback),
                    name: String(manifest.name ?? manifest.Name ?? rawId),
                    dependencies: dependencies,
                    priority: Number(manifest.priority ?? 0)
                });
            } catch {}
        }
        if (!roots.size) roots.set("", {
            path: "",
            id: normalizedId(fallback, "DownloadedMod"),
            name: fallback,
            dependencies: [],
            priority: 0
        });
        return Array.from(roots.values()).sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
    }
    async function digest(bytes) {
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    async function decodeAsset(modId, archiveHash, file) {
        const scale = /(^|\/)assets\/2x\//i.test(file.path) ? 2 : 1;
        const key = `${archiveHash}:${scale}:${file.path}`;
        try {
            const imageBytes = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
            const bitmap = await createImageBitmap(new Blob([ imageBytes ]));
            if (bitmap.width > MAX_TEXTURE_DIMENSION || bitmap.height > MAX_TEXTURE_DIMENSION) {
                bitmap.close();
                return {
                    key: key,
                    modId: modId,
                    archiveHash: archiveHash,
                    sourcePath: file.path,
                    width: 0,
                    height: 0,
                    scale: scale,
                    rgba: new ArrayBuffer(0),
                    disabledReason: `Texture exceeds ${MAX_TEXTURE_DIMENSION}px GPU safety limit.`
                };
            }
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d", {
                willReadFrequently: true
            });
            if (!context) throw new Error("Canvas image decoding is unavailable.");
            context.clearRect(0, 0, bitmap.width, bitmap.height);
            context.drawImage(bitmap, 0, 0);
            const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data.slice().buffer;
            const result = {
                key: key,
                modId: modId,
                archiveHash: archiveHash,
                sourcePath: file.path,
                width: bitmap.width,
                height: bitmap.height,
                scale: scale,
                rgba: rgba
            };
            bitmap.close();
            return result;
        } catch (error) {
            return {
                key: key,
                modId: modId,
                archiveHash: archiveHash,
                sourcePath: file.path,
                width: 0,
                height: 0,
                scale: scale,
                rgba: new ArrayBuffer(0),
                disabledReason: `Image decode failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    var installQueue = Promise.resolve();
    async function installBrowserArchiveNow(input) {
        const unpacked = await unpack(input.name, input.type ?? "", input.bytes);
        const wrapper = commonWrapper(unpacked.files);
        const files = unpacked.files.map(file => ({
            ...file,
            path: wrapper ? file.path.slice(wrapper.length) : file.path
        })).filter(file => file.path);
        const fallback = input.displayName || input.name.replace(/\.(?:zip|tar|tar\.gz|tgz)$/i, "");
        const roots = detectRoots(files, fallback);
        const Zip = window.JSZip;
        const canonical = new Zip;
        for (const file of files) canonical.file(file.path, file.bytes);
        const bytes = await canonical.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: {
                level: 6
            },
            streamFiles: true
        });
        const archiveHash = await digest(bytes);
        const installed = [];
        const previous = await getMods();
        for (const root of roots) {
            const id = normalizedId(root.id, `mod-${Date.now()}`);
            const owned = roots.length === 1 ? files : files.filter(file => root.path ? file.path === root.path || file.path.startsWith(`${root.path}/`) : true);
            const warnings = [];
            const nativeFiles = owned.filter(file => isNativeBinary(file.path));
            if (nativeFiles.length) warnings.push(`${nativeFiles.length} desktop-only native ${nativeFiles.length === 1 ? "file will" : "files will"} be ignored by the browser launch.`);
            const allTextures = owned.filter(file => IMAGE_PATTERN.test(file.path));
            const texturePaths = new Set(allTextures.map(file => file.path.toLowerCase()));
            const textures = allTextures.filter(file => !/(^|\/)assets\/2x\//i.test(file.path) || !texturePaths.has(file.path.replace(/(^|\/)assets\/2x\//i, "$1assets/1x/").toLowerCase())).sort((a, b) => a.bytes.byteLength - b.bytes.byteLength);
            let cachedRawBytes = 0;
            let cacheUnavailable = false;
            for (const texture of textures) {
                if (cacheUnavailable || cachedRawBytes >= MAX_RAW_CACHE_BYTES_PER_MOD) break;
                const asset = await decodeAsset(id, archiveHash, texture);
                if (asset.disabledReason) warnings.push(`${texture.path}: ${asset.disabledReason}`);
                if (!asset.disabledReason && cachedRawBytes + asset.rgba.byteLength > MAX_RAW_CACHE_BYTES_PER_MOD) continue;
                try {
                    await putAsset(asset);
                    cachedRawBytes += asset.rgba.byteLength;
                } catch (error) {
                    warnings.push(`Raw texture cache quota unavailable; packaged images will decode at launch (${String(error)})`);
                    cacheUnavailable = true;
                }
            }
            const old = previous.find(mod2 => mod2.id === id);
            const mod = {
                id: id,
                name: root.name || fallback,
                version: input.version ?? "",
                fileName: `${id}.zip`,
                size: bytes.byteLength,
                enabled: old?.enabled ?? true,
                lovelyPatches: owned.some(file => /(^|\/)lovely(?:\/.*\.toml|\.toml)$/i.test(file.path)),
                fileCount: owned.length,
                bytes: bytes,
                updatedAt: Date.now(),
                path: `webmods://${id}`,
                sourceUrl: input.sourceUrl,
                dependencies: root.dependencies,
                dependencyIds: root.dependencies,
                archiveHash: archiveHash,
                archiveType: unpacked.type,
                roots: [ root ],
                processedTextureScales: Array.from(new Set(allTextures.map(file => /(^|\/)assets\/2x\//i.test(file.path) ? 2 : 1))),
                compatibilityStatus: warnings.length ? "limited" : allTextures.length ? "repaired" : "compatible",
                warnings: warnings
            };
            await putMod(mod);
            installed.push(mod);
        }
        return installed;
    }
    function installBrowserArchive(input) {
        const operation = installQueue.then(() => installBrowserArchiveNow(input), () => installBrowserArchiveNow(input));
        installQueue = operation.catch(() => void 0);
        return operation;
    }
    var LOVELY_VERSION = "0.9.0-web.1";
    function enableDebugConsole() {
        if (!new URLSearchParams(location.search).has("lovely-debug")) return;
        const lines = [];
        let output = null;
        const render = () => {
            if (!output) {
                output = document.createElement("pre");
                output.id = "lovely-web-debug";
                output.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:38vh;overflow:auto;margin:0;padding:10px;background:#050505e8;color:#b8ffb8;font:13px/1.35 monospace;white-space:pre-wrap;pointer-events:none";
                document.body.append(output);
            }
            output.textContent = lines.slice(-80).join("\n");
        };
        lines.push("[LovelyWeb] Debug capture enabled");
        if (document.body) render(); else addEventListener("DOMContentLoaded", render, {
            once: true
        });
        for (const method of [ "log", "info", "warn", "error" ]) {
            try {
                const original = console[method].bind(console);
                console[method] = (...args) => {
                    original(...args);
                    const text = args.map(value => value instanceof Error ? value.stack || value.message : typeof value === "string" ? value : JSON.stringify(value)).join(" ");
                    if (text && !/Added non-passive event listener|\[Violation\]/i.test(text)) {
                        lines.push(text);
                        if (document.body) render(); else addEventListener("DOMContentLoaded", render, {
                            once: true
                        });
                    }
                };
            } catch {}
        }
    }
    if (typeof window !== "undefined") {
        enableDebugConsole();
    }
    function safeSegment(value, fallback) {
        const cleaned = String(value || "").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
        return cleaned || fallback;
    }
    function normalizedArchiveFiles(archive) {
        const names = Object.values(archive.files);
        const safeNames = names.filter(entry => !entry.dir && !/(^|\/)__MACOSX\//i.test(entry.name)).map(entry => String(entry.name).replaceAll("\\", "/").replace(/^\/+/, "")).filter(name => name && !name.split("/").includes(".."));
        const roots = new Set(safeNames.filter(name => name.includes("/")).map(name => name.split("/")[0]));
        const hasRootFiles = safeNames.some(name => !name.includes("/"));
        const stripRoot = !hasRootFiles && roots.size === 1 ? `${Array.from(roots)[0]}/` : "";
        return safeNames.map(name => ({
            source: name,
            target: name.slice(stripRoot.length)
        })).filter(entry => entry.target);
    }
    function isNativeBinary(path) {
        return /\.(?:dll|exe|so|dylib|node|pdb|a|lib)$/i.test(path);
    }
    async function addModToGame(gameArchive, mod) {
        const destination = `WebMods/${safeSegment(mod.id, "DownloadedMod")}`;
        if (/\.lua$/i.test(mod.fileName || "")) {
            gameArchive.file(`${destination}/${safeSegment(mod.fileName, "main")}.lua`, mod.bytes);
            return;
        }
        const uploaded = await window.JSZip.loadAsync(mod.bytes);
        const root = mod.roots?.[0]?.path?.replace(/^\/+|\/+$/g, "") || "";
        const entries = normalizedArchiveFiles(uploaded).filter(entry => !root || entry.target === root || entry.target.startsWith(`${root}/`));
        const skipped = [];
        for (const entry of entries) {
            const file = uploaded.file(entry.source);
            const relative = root ? entry.target.slice(root.length).replace(/^\/+/, "") : entry.target;
            if (isNativeBinary(relative)) {
                skipped.push(relative);
                continue;
            }
            if (file && relative) gameArchive.file(`${destination}/${relative}`, await file.async("uint8array"));
        }
        if (skipped.length) {
            const warning = `${skipped.length} desktop-only native ${skipped.length === 1 ? "file was" : "files were"} ignored for the browser launch.`;
            mod.warnings = Array.from(new Set([ ...mod.warnings || [], warning ]));
            if (mod.compatibilityStatus === "compatible") mod.compatibilityStatus = "limited";
            await putMod(mod);
            console.warn(`[ModRuntime] ${mod.name || mod.id}: ${warning}`);
        }
    }
    async function forceRunSetupMenu(archive) {
        const path = "functions/UI_definitions.lua";
        const source = await readText(archive, path);
        if (!source) return false;
        const patched = source.replace(/button\s*=\s*not\s+G\.SETTINGS\.tutorial_complete\s+and\s*(["'])start_run\1\s+or\s*(["'])setup_run\2/, 'button = "setup_run"');
        if (patched === source) return false;
        archive.file(path, patched);
        console.info("[ModRuntime] The Play button now always opens the New Run menu.");
        return true;
    }
    async function installSeedClipboardBridge(archive) {
        const path = "js.lua";
        const source = await readText(archive, path);
        if (!source || source.includes('type":"clipboard","action":"read_seed"')) return false;
        const blocked = /function JS\.callJS\(funcToCall\)\s*\n\s*if\(os == "Web"\) then\s*\n\s*-- Arbitrary page JavaScript is intentionally unavailable to mods\.\s*\n\s*-- Browser integration is limited to the structured event bridge\.\s*\n\s*print\('BALATRO_WEB_BRIDGE \{"type":"warning","message":"Blocked legacy arbitrary JavaScript bridge call"\}'\)\s*\n\s*end\s*\nend/;
        const replacement = `function JS.callJS(funcToCall)
    if(os == "Web") then
        local target = type(funcToCall) == "string" and funcToCall:match("FS%.writeFile%('([^']+/__temp%d+)'") or nil
        if target and target:match("^/home/web_user/.+/__temp%d+$") and funcToCall:find("navigator.clipboard.readText", 1, true) then
            local safe_target = target:gsub('\\\\', '\\\\\\\\'):gsub('"', '\\\\"')
            print('BALATRO_WEB_BRIDGE {"type":"clipboard","action":"read_seed","target":"' .. safe_target .. '"}')
            return
        end
        -- Arbitrary page JavaScript remains unavailable to mods. Only the
        -- validated seed clipboard request above crosses the web bridge.
        print('BALATRO_WEB_BRIDGE {"type":"warning","message":"Blocked legacy arbitrary JavaScript bridge call"}')
    end
end`;
        const patched = source.replace(blocked, replacement);
        if (patched === source) return false;
        archive.file(path, patched);
        console.info("[ModRuntime] Enabled the restricted seed clipboard bridge.");
        return true;
    }
    function luaString(value) {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    function assetTarget(mod, asset) {
        const root = mod.roots?.[0]?.path?.replace(/^\/+|\/+$/g, "") || "";
        if (root && !(asset.sourcePath === root || asset.sourcePath.startsWith(`${root}/`))) return null;
        const relative = root ? asset.sourcePath.slice(root.length).replace(/^\/+/, "") : asset.sourcePath;
        return `WebMods/${safeSegment(mod.id, "DownloadedMod")}/${relative}`;
    }
    async function installRawTextureSidecars(archive, mods) {
        const all = await getAssets();
        const lines = [ "return {" ];
        let count = 0;
        let rawBytes = 0;
        const rawBudget = 64 * 1024 * 1024;
        for (const mod of mods) {
            const assets = all.filter(asset => asset.modId === mod.id && !asset.disabledReason && asset.width > 0 && asset.height > 0);
            const paths = new Set(assets.map(asset => asset.sourcePath.toLowerCase()));
            const selected = assets.filter(asset => asset.scale === 1 || !paths.has(asset.sourcePath.replace(/(^|\/)assets\/2x\//i, "$1assets/1x/").toLowerCase())).sort((a, b) => a.rgba.byteLength - b.rgba.byteLength);
            for (const asset of selected) {
                if (rawBytes + asset.rgba.byteLength > rawBudget) continue;
                const target = assetTarget(mod, asset);
                if (!target) continue;
                const rawPath = `WebAssets/${asset.key.replace(/[^A-Za-z0-9_.-]+/g, "_")}.rgba`;
                archive.file(rawPath, asset.rgba);
                lines.push(`  [${luaString(target.toLowerCase())}] = { raw = ${luaString(rawPath)}, width = ${asset.width}, height = ${asset.height}, scale = ${asset.scale} },`);
                rawBytes += asset.rgba.byteLength;
                count++;
            }
        }
        lines.push("}");
        archive.file("web_atlases.lua", `${lines.join("\n")}\n`);
        console.info(`[LovelyWeb] Packaged ${count} browser-decoded texture atlases (${Math.round(rawBytes / 1024 / 1024)} MB raw cache); remaining textures use LOVE's encoded-image path.`);
    }
    function archivePaths(archive) {
        return Object.keys(archive.files).filter(path => !archive.files[path].dir);
    }
    async function normalizeGameArchivePaths(archive) {
        const legacyPaths = Object.keys(archive.files).filter(path => path.includes("\\"));
        for (const oldPath of legacyPaths) {
            const entry = archive.files[oldPath];
            const newPath = oldPath.replaceAll("\\", "/");
            if (!entry.dir) archive.file(newPath, await entry.async("uint8array"));
            archive.remove(oldPath);
        }
    }
    async function readText(archive, path) {
        const file = archive.file(path);
        return file ? file.async("string") : null;
    }
    function normalizeId(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function dependencyOrder(mods) {
        const byId = new Map(mods.map(mod => [ normalizeId(mod.id), mod ]));
        const result = [];
        const visiting = new Set;
        const visited = new Set;
        const visit = mod => {
            const id = normalizeId(mod.id);
            if (visited.has(id) || visiting.has(id)) return;
            visiting.add(id);
            for (const raw of mod.dependencyIds ?? mod.dependencies ?? []) {
                const dependency = byId.get(normalizeId(String(raw).replace(/\s*\(.*$/, "")));
                if (dependency) visit(dependency);
            }
            visiting.delete(id);
            visited.add(id);
            result.push(mod);
        };
        [ ...mods ].sort((a, b) => Number(a.roots?.[0]?.priority ?? 0) - Number(b.roots?.[0]?.priority ?? 0)).forEach(visit);
        return result;
    }
    async function buildModRootMap(archive) {
        const roots = new Set;
        for (const path of archivePaths(archive)) {
            const match = path.match(/^WebMods\/([^/]+)\//);
            if (match) roots.add(match[1]);
        }
        const result = new Map;
        for (const rootName of roots) {
            const root = `WebMods/${rootName}`;
            result.set(normalizeId(rootName), root);
            if (normalizeId(rootName) === "steamodded") result.set("smods", root);
            const manifests = archivePaths(archive).filter(path => {
                const relative = path.slice(root.length + 1);
                return path.startsWith(`${root}/`) && !relative.includes("/") && /\.json$/i.test(relative);
            });
            for (const manifest of manifests) {
                try {
                    const parsed = JSON.parse(await readText(archive, manifest) || "{}");
                    for (const key of [ parsed.id, parsed.ID, parsed.name, parsed.Name ]) {
                        if (key) result.set(normalizeId(key), root);
                    }
                } catch {}
            }
        }
        return result;
    }
    function targetValues(value) {
        return (Array.isArray(value) ? value : [ value ]).filter(entry => typeof entry === "string");
    }
    function resolveTargets(archive, rootMap, target) {
        const clean = target.replace(/^@/, "");
        if (archive.file(clean)) return [ clean ];
        const buffer = clean.match(/^=\[SMODS\s+([^\s]+)\s+"([^"]+)"\]$/i);
        if (buffer) {
            const root = buffer[1] === "_" ? rootMap.get("steamodded") : rootMap.get(normalizeId(buffer[1]));
            const path = root ? `${root}/${buffer[2].replace(/^\/+/, "")}` : "";
            return path && archive.file(path) ? [ path ] : [];
        }
        return [];
    }
    async function collectLovelyPatches(archive) {
        const paths = archivePaths(archive);
        const patchPaths = paths.filter(path => !/^WebMods\/Steamodded\//i.test(path) && /^WebMods\/[^/]+\/(?:lovely\.toml|lovely\/.*\.toml)$/i.test(path));
        const patches = [];
        const vars = {};
        let order = 0;
        for (const patchPath of patchPaths) {
            const rootMatch = patchPath.match(/^(WebMods\/[^/]+)\//);
            if (!rootMatch) continue;
            const modRoot = rootMatch[1];
            try {
                let source = await readText(archive, patchPath) || "";
                source = source.replaceAll("{{lovely_hack:patch_dir}}", modRoot);
                const document2 = parse(source);
                const priority = Number(document2.manifest?.priority || 0);
                const documentVars = Object.fromEntries(Object.entries(document2.vars || {}).map(([key, value]) => [ key, String(value) ]));
                Object.assign(vars, documentVars);
                for (const entry of document2.patches || []) {
                    for (const kind of [ "module", "copy", "pattern", "regex" ]) {
                        if (entry[kind]) {
                            patches.push({
                                kind: kind,
                                data: entry[kind],
                                priority: priority,
                                order: order++,
                                modRoot: modRoot,
                                patchPath: patchPath,
                                vars: documentVars
                            });
                        }
                    }
                }
            } catch (error) {
                console.warn(`[LovelyWeb] Could not parse ${patchPath}`, error);
            }
        }
        return {
            patches: patches,
            vars: vars
        };
    }
    function luaQuote(value) {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    async function installModulePatches(archive, patches) {
        const modules = patches.filter(patch => patch.kind === "module").sort((a, b) => a.priority - b.priority || a.order - b.order);
        const injections = new Map;
        for (const patch of modules) {
            const sourcePath = `${patch.modRoot}/${String(patch.data.source || "").replace(/^\/+/, "")}`;
            const source = await readText(archive, sourcePath);
            if (source == null || !patch.data.name) {
                console.warn(`[LovelyWeb] Missing module source for ${patch.patchPath}: ${sourcePath}`);
                continue;
            }
            const target = patch.data.load_now ? String(patch.data.before || "main.lua") : "main.lua";
            const lines = [ `package.preload[${luaQuote(String(patch.data.name))}] = function(...)`, source, "end" ];
            if (patch.data.load_now) lines.push(`package.loaded[${luaQuote(String(patch.data.name))}] = require(${luaQuote(String(patch.data.name))})`);
            const list = injections.get(target) || [];
            list.push(lines.join("\n"));
            injections.set(target, list);
        }
        for (const [target, chunks] of injections) {
            const source = await readText(archive, target);
            if (source == null) {
                console.warn(`[LovelyWeb] Module insertion target was not found: ${target}`);
                continue;
            }
            archive.file(target, `${chunks.join("\n")}\n${source}`);
        }
    }
    function applyCopy(text, patch, contents) {
        const payloads = [ ...contents ];
        if (typeof patch.data.payload === "string") payloads.push(patch.data.payload);
        for (const payload of payloads) {
            text = String(patch.data.position).toLowerCase() === "prepend" ? `${payload}\n${text}` : `${text}\n${payload}`;
        }
        return text;
    }
    function wildcardRegex(pattern) {
        let source = "";
        for (const char of pattern) {
            if (char === "*") source += ".*"; else if (char === "?") source += "."; else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
        }
        return new RegExp(`^${source}$`, "u");
    }
    function lineOffsets(text) {
        const lines = text.split("\n");
        const offsets = [];
        let offset = 0;
        for (const line of lines) {
            offsets.push(offset);
            offset += line.length + 1;
        }
        return {
            lines: lines,
            offsets: offsets
        };
    }
    function indentedPayload(payload, indent) {
        let result = String(payload).split(/(?<=\n)/).map(line => `${indent}${line}`).join("");
        if (!result.endsWith("\n")) result += "\n";
        return result;
    }
    function applyPattern(text, patch) {
        const patternLines = String(patch.data.pattern || "").replace(/\r\n/g, "\n").split("\n");
        if (patternLines.at(-1) === "") patternLines.pop();
        const matchers = patternLines.map(line => wildcardRegex(line.trim()));
        if (!matchers.length) return {
            text: text,
            count: 0
        };
        const {lines: lines, offsets: offsets} = lineOffsets(text);
        const matches = [];
        for (let index = 0; index + matchers.length <= lines.length; index++) {
            if (matchers.every((matcher, part) => matcher.test(lines[index + part].trim()))) {
                const start = offsets[index];
                const nextLine = index + matchers.length;
                const end = nextLine < offsets.length ? offsets[nextLine] : text.length;
                matches.push({
                    start: start,
                    end: end,
                    indent: patch.data.match_indent ? (lines[index].match(/^[\t ]*/) || [ "" ])[0] : ""
                });
                index += matchers.length - 1;
            }
        }
        const wanted = patch.data.times == null ? matches.length : Math.min(matches.length, Number(patch.data.times));
        for (const match of matches.slice(0, wanted).reverse()) {
            const payload = indentedPayload(String(patch.data.payload || ""), match.indent);
            const position = String(patch.data.position || "at").toLowerCase();
            if (position === "before") text = text.slice(0, match.start) + payload + text.slice(match.start); else if (position === "after") text = text.slice(0, match.end) + payload + text.slice(match.end); else text = text.slice(0, match.start) + payload + text.slice(match.end);
        }
        return {
            text: text,
            count: wanted
        };
    }
    function stripVerboseRegex(pattern) {
        let result = "";
        let inClass = false;
        let escaped = false;
        for (let index = 0; index < pattern.length; index++) {
            const char = pattern[index];
            if (escaped) {
                result += char;
                escaped = false;
                continue;
            }
            if (char === "\\") {
                result += char;
                escaped = true;
                continue;
            }
            if (char === "[") inClass = true;
            if (char === "]") inClass = false;
            if (!inClass && char === "#") {
                while (index < pattern.length && pattern[index] !== "\n") index++;
                continue;
            }
            if (!inClass && /\s/.test(char)) continue;
            result += char;
        }
        return result;
    }
    function interpolateCaptures(template, match) {
        return template.replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*|\d+))/g, (_all, braced, plain) => {
            const key = braced || plain;
            if (/^\d+$/.test(key)) return match[Number(key)] || "";
            return match.groups?.[key] || "";
        });
    }
    function applyRegex(text, patch) {
        try {
            const source = patch.data.verbose ? stripVerboseRegex(String(patch.data.pattern || "")) : String(patch.data.pattern || "");
            const regex = new RegExp(source, "gmd");
            const matches = [];
            let match;
            while (match = regex.exec(text)) {
                matches.push(match);
                if (!match[0].length) regex.lastIndex++;
            }
            const wanted = patch.data.times == null ? matches.length : Math.min(matches.length, Number(patch.data.times));
            for (const item of matches.slice(0, wanted).reverse()) {
                const indices = item.indices;
                const rootName = String(patch.data.root_capture || "0").replace(/^\$/, "");
                const span = /^\d+$/.test(rootName) ? indices?.[Number(rootName)] : indices?.groups?.[rootName];
                if (!span) continue;
                const linePrepend = interpolateCaptures(String(patch.data.line_prepend || ""), item);
                let payload = String(patch.data.payload || "").split(/(?<=\n)/).map(line => `${linePrepend}${line}`).join("");
                payload = interpolateCaptures(payload, item);
                const position = String(patch.data.position || "at").toLowerCase();
                const [start, end] = span;
                if (position === "before") text = text.slice(0, start) + payload + text.slice(start); else if (position === "after") text = text.slice(0, end) + payload + text.slice(end); else text = text.slice(0, start) + payload + text.slice(end);
            }
            return {
                text: text,
                count: wanted
            };
        } catch (error) {
            console.warn(`[LovelyWeb] Invalid regex in ${patch.patchPath}`, error);
            return {
                text: text,
                count: 0
            };
        }
    }
    function interpolateVariables(text, vars) {
        return text.replace(/\{\{lovely:(\w+)\}\}/g, (all, name) => Object.hasOwn(vars, name) ? vars[name] : all);
    }
    async function applyLovelyPatches(archive) {
        const {patches: patches, vars: vars} = await collectLovelyPatches(archive);
        if (!patches.length) return;
        const rootMap = await buildModRootMap(archive);
        await installModulePatches(archive, patches);
        const modified = new Set;
        const copyPatches = patches.filter(patch => patch.kind === "copy").sort((a, b) => a.priority - b.priority || a.order - b.order);
        for (const patch of copyPatches) {
            const contents = [];
            for (const source of patch.data.sources || []) {
                const value = await readText(archive, `${patch.modRoot}/${String(source).replace(/^\/+/, "")}`);
                if (value != null) contents.push(value);
            }
            for (const target of targetValues(patch.data.target)) {
                for (const path of resolveTargets(archive, rootMap, target)) {
                    const source = await readText(archive, path);
                    if (source != null) {
                        archive.file(path, applyCopy(source, patch, contents));
                        modified.add(path);
                    }
                }
            }
        }
        const sourcePatches = [ ...patches.filter(patch => patch.kind === "pattern"), ...patches.filter(patch => patch.kind === "regex") ].sort((a, b) => a.priority - b.priority || a.order - b.order);
        let applied = 0;
        let missed = 0;
        for (const patch of sourcePatches) {
            for (const target of targetValues(patch.data.target)) {
                const paths = resolveTargets(archive, rootMap, target);
                if (!paths.length) {
                    missed++;
                    console.warn(`[LovelyWeb] Target not found: ${target} (${patch.patchPath})`);
                    continue;
                }
                for (const path of paths) {
                    const source = await readText(archive, path);
                    if (source == null) continue;
                    const result = patch.kind === "pattern" ? applyPattern(source, patch) : applyRegex(source, patch);
                    result.text = result.text.replace(/if\s+not\s+area\.cards\s+then\s+goto\s+continue\s+end/g, "if not area.cards then area.cards = {} end");
                    if (result.count) {
                        archive.file(path, result.text);
                        modified.add(path);
                        applied += result.count;
                    } else {
                        missed++;
                        console.warn(`[LovelyWeb] Patch did not match ${target} (${patch.patchPath})`);
                    }
                }
            }
        }
        for (const path of modified) {
            const source = await readText(archive, path);
            if (source != null) archive.file(path, interpolateVariables(source, vars));
        }
        console.info(`[LovelyWeb] Applied ${applied} source patches across ${modified.size} files; ${missed} patches were skipped.`);
    }
    function luaIndentWidth(indent) {
        return [ ...indent ].reduce((width, char) => width + (char === "\t" ? 4 : 1), 0);
    }
    function transpileContinueLabels(source) {
        const lines = source.split("\n");
        let count = 0;
        const labels = [];
        for (let index = 0; index < lines.length; index++) {
            if (/^(\s*)::continue::\s*(?:--.*)?$/.test(lines[index])) labels.push(index);
        }
        for (const labelIndex of labels.reverse()) {
            const label = lines[labelIndex].match(/^(\s*)::continue::\s*(?:--.*)?$/);
            if (!label) continue;
            const labelWidth = luaIndentWidth(label[1]);
            let loopIndex = -1;
            for (let index = labelIndex - 1; index >= 0; index--) {
                const loop = lines[index].match(/^(\s*)(?:for|while)\b.*\bdo\s*(?:--.*)?$/);
                if (!loop || luaIndentWidth(loop[1]) >= labelWidth) continue;
                loopIndex = index;
                break;
            }
            if (loopIndex < 0) continue;
            const loop = lines[loopIndex].match(/^(\s*)/);
            const loopWidth = luaIndentWidth(loop[1]);
            let loopEnd = -1;
            for (let index = labelIndex + 1; index < lines.length; index++) {
                const closing = lines[index].match(/^(\s*)end\b/);
                if (closing && luaIndentWidth(closing[1]) === loopWidth) {
                    loopEnd = index;
                    break;
                }
                const content = lines[index].match(/^(\s*)\S/);
                if (content && luaIndentWidth(content[1]) < loopWidth) break;
            }
            if (loopEnd < 0) continue;
            let bodyIndent = `${loop[1]}\t`;
            for (let index = loopIndex + 1; index < labelIndex; index++) {
                const content = lines[index].match(/^(\s*)\S/);
                if (content && luaIndentWidth(content[1]) > loopWidth) {
                    bodyIndent = content[1];
                    break;
                }
            }
            let replacements = 0;
            for (let index = loopIndex + 1; index < labelIndex; index++) {
                lines[index] = lines[index].replace(/\bgoto\s+continue\b/g, () => {
                    replacements++;
                    return "break";
                });
            }
            if (!replacements) continue;
            lines.splice(labelIndex, 1);
            loopEnd--;
            lines.splice(loopEnd, 0, `${bodyIndent}until true`);
            lines.splice(loopIndex + 1, 0, `${bodyIndent}repeat`);
            count++;
        }
        return {
            text: lines.join("\n"),
            count: count
        };
    }
    async function installLua51Compatibility(archive) {
        let repaired = 0;
        for (const path of Object.keys(archive.files).filter(entry => /\.lua$/i.test(entry))) {
            const source = await readText(archive, path);
            if (!source || !source.includes("goto continue") || !source.includes("::continue::")) continue;
            const result = transpileContinueLabels(source);
            if (!result.count) continue;
            archive.file(path, result.text);
            repaired += result.count;
        }
        if (repaired) console.info(`[ModRuntime] Repaired ${repaired} Lua 5.2 continue block(s) for the web runtime.`);
    }
    async function applyWebCompatibilityPatches(archive) {
        const path = "game.lua";
        const source = await readText(archive, path);
        if (source == null) return;
        const smodsUtilsPath = "WebMods/Steamodded/src/utils.lua";
        const smodsUtils = await readText(archive, smodsUtilsPath);
        if (smodsUtils && !smodsUtils.includes("if not t.set and t.key == 'c_base' then t.set = 'Base' end")) {
            const marker = "function SMODS.create_card(t)\n";
            if (smodsUtils.includes(marker)) {
                archive.file(smodsUtilsPath, smodsUtils.replace(marker, `${marker}    if not t.set and t.key == 'c_base' then t.set = 'Base' end\n`));
            }
        }
        const originalSet = "if v.set and v.set ~= 'Joker' and not v.skip_pool and not v.omit then table.insert(self.P_CENTER_POOLS[v.set], v) end";
        const guardedSet = "if v.set and v.set ~= 'Joker' and not v.skip_pool and not v.omit and self.P_CENTER_POOLS[v.set] then table.insert(self.P_CENTER_POOLS[v.set], v) end";
        const original = "if v.rarity and v.set == 'Joker' and not v.demo then table.insert(self.P_JOKER_RARITY_POOLS[v.rarity], v) end";
        const guarded = "if v.rarity and v.set == 'Joker' and not v.demo and self.P_JOKER_RARITY_POOLS[v.rarity] then table.insert(self.P_JOKER_RARITY_POOLS[v.rarity], v) end";
        const patched = source.replace(originalSet, guardedSet).replace(original, guarded);
        if (patched !== source) {
            archive.file(path, patched);
            console.info("[LovelyWeb] Applied Steamodded custom-rarity reload compatibility patch.");
        }
        for (const loggingPath of [ "WebMods/Steamodded/src/preflight/logging.lua", "SMODS/preflight/logging.lua" ]) {
            const logging = await readText(archive, loggingPath);
            if (!logging) continue;
            const browserSafeLogging = logging.replace(/\ninitializeSocketConnection\(\)\s*\n(\s*-- Use the function)/, '\nif love.system.getOS() ~= "Web" then initializeSocketConnection() end\n$1');
            if (browserSafeLogging !== logging) archive.file(loggingPath, browserSafeLogging);
        }
        const localizationPath = "functions/misc_functions.lua";
        const localization = await readText(archive, localizationPath);
        if (localization && !localization.includes("local function flatten(value)")) {
            const marker = "function loc_parse_string(line)\n";
            const normalizer = `function loc_parse_string(line)\n  if type(line) ~= 'string' then\n    local flat = {}\n    local function flatten(value)\n      if type(value) == 'table' then\n        for _, child in ipairs(value) do flatten(child) end\n      elseif value ~= nil then\n        flat[#flat + 1] = tostring(value)\n      end\n    end\n    flatten(line)\n    line = table.concat(flat, '')\n  end\n`;
            if (localization.includes(marker)) {
                archive.file(localizationPath, localization.replace(marker, normalizer));
                console.info("[LovelyWeb] Installed defensive nested-table localization normalization.");
            }
        }
    }
    function lovelyMetadata() {
        return `local values = {}\n\nreturn {\n    repo = 'https://github.com/ethangreen-dev/lovely-injector',\n    version = '${LOVELY_VERSION}',\n    mod_dir = 'WebMods',\n    log_file = 'smods-data/lovely/logs/web.log',\n    log_path = 'smods-data/lovely/logs/web.log',\n    web_runtime = true,\n    reload_patches = function() return true end,\n    apply_patches = function(_, buffer) return buffer end,\n    set_var = function(name, value) values[name] = tostring(value); return values[name] end,\n    get_var = function(name) return values[name] end,\n    remove_var = function(name) local value = values[name]; values[name] = nil; return value end,\n}\n`;
    }
    function generateGameArchive(archive) {
        return archive.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: {
                level: 6
            },
            streamFiles: true
        });
    }
    async function prepareGameArchive(arrayBuffer) {
        try {
            const safeMode = sessionStorage.getItem("balatro-web-safe-mode") === "1";
            if (safeMode) sessionStorage.removeItem("balatro-web-safe-mode");
            let stored = await getMods();
            if (!safeMode) {
                for (const legacy of stored.filter(mod => !mod.archiveHash || !mod.roots)) {
                    try {
                        const bytes = legacy.bytes instanceof Blob ? await legacy.bytes.arrayBuffer() : legacy.bytes instanceof Uint8Array ? legacy.bytes.slice().buffer : legacy.bytes;
                        await installBrowserArchive({
                            name: legacy.fileName || `${legacy.id}.zip`,
                            type: "application/zip",
                            bytes: bytes,
                            displayName: legacy.name,
                            version: legacy.version,
                            sourceUrl: legacy.sourceUrl
                        });
                    } catch (error) {
                        legacy.warnings = [ ...legacy.warnings ?? [], `Metadata and texture migration failed: ${String(error)}` ];
                        legacy.compatibilityStatus = "limited";
                        await putMod(legacy);
                    }
                }
                stored = await getMods();
            }
            const requested = safeMode ? [] : dependencyOrder(stored.filter(mod => mod.enabled));
            const archive = await window.JSZip.loadAsync(arrayBuffer);
            await normalizeGameArchivePaths(archive);
            const runSetupPatched = await forceRunSetupMenu(archive);
            const seedClipboardPatched = await installSeedClipboardBridge(archive);
            if (!requested.length) return runSetupPatched || seedClipboardPatched ? generateGameArchive(archive) : arrayBuffer;
            archive.file("lovely.lua", lovelyMetadata());
            const mods = [];
            for (const mod of requested) {
                try {
                    await addModToGame(archive, mod);
                    mods.push(mod);
                } catch (error) {
                    mod.enabled = false;
                    mod.disabledReason = `Archive could not be prepared: ${String(error)}`;
                    mod.compatibilityStatus = "disabled";
                    mod.warnings = [ ...mod.warnings ?? [], mod.disabledReason ];
                    await putMod(mod);
                    await putLaunchReport({
                        id: `${Date.now()}-${crypto.randomUUID()}`,
                        createdAt: Date.now(),
                        status: "warning",
                        modId: mod.id,
                        stage: "archive",
                        message: mod.disabledReason,
                        enabledMods: requested.filter(item => item.enabled).map(item => item.id)
                    });
                }
            }
            if (!mods.length) return runSetupPatched ? generateGameArchive(archive) : arrayBuffer;
            try {
                await installRawTextureSidecars(archive, mods);
            } catch (error) {
                console.warn("[ModRuntime] Raw texture cache was skipped; packaged images remain available.", error);
            }
            try {
                await applyLovelyPatches(archive);
            } catch (error) {
                console.warn("[ModRuntime] One or more native-only patches were skipped.", error);
            }
            try {
                await installLua51Compatibility(archive);
            } catch (error) {
                console.warn("[ModRuntime] Lua 5.1 compatibility repair was skipped.", error);
            }
            try {
                await applyWebCompatibilityPatches(archive);
            } catch (error) {
                console.warn("[ModRuntime] Optional compatibility repair was skipped.", error);
            }
            return await generateGameArchive(archive);
        } catch (error) {
            console.error("[ModRuntime] Mod preparation failed; starting Steamodded without downloaded mods.", error);
            sessionStorage.setItem("balatro-web-safe-mode", "1");
            return arrayBuffer;
        }
    }
    if (typeof window !== "undefined") {
        window.__getWebDB ||= name => {
            try {
                return localStorage.getItem(name);
            } catch {
                return null;
            }
        };
        let activeStage = {};
        const clipboard = async (payload = {}) => {
            const target = String(payload.target ?? "");
            if (!/^\/home\/web_user\/.+\/__temp\d+$/.test(target) || target.includes("..")) return;
            let text = "";
            try {
                text = await (window.BalatroSeedClipboard?.readClipboard?.() ?? navigator.clipboard?.readText?.() ?? "");
            } catch {}
            try {
                window.FS?.writeFile(target, String(text || ""));
            } catch (error) {
                console.warn("[ModRuntime] Could not deliver the clipboard seed.", error);
            }
        };
        const record = async (status, payload = {}) => {
            const mods = await getMods();
            const modId = String(payload.modId ?? activeStage.modId ?? "") || void 0;
            const report = {
                id: `${Date.now()}-${crypto.randomUUID()}`,
                createdAt: Date.now(),
                status: status,
                stage: String(payload.stage ?? activeStage.stage ?? "") || void 0,
                modId: modId,
                message: String(payload.message ?? "") || void 0,
                enabledMods: mods.filter(mod => mod.enabled).map(mod => mod.id)
            };
            await putLaunchReport(report);
            let disabled = false;
            if (status === "crash" && modId) {
                const culprit = mods.find(mod => normalizeId(mod.id) === normalizeId(modId));
                if (culprit) {
                    culprit.enabled = false;
                    culprit.disabledReason = `Automatically disabled after startup crash during ${report.stage || "mod injection"}.`;
                    culprit.compatibilityStatus = "disabled";
                    await putMod(culprit);
                    disabled = true;
                }
            }
            if (status === "crash" && !disabled && mods.some(mod => mod.enabled)) {
                sessionStorage.setItem("balatro-web-safe-mode", "1");
                await putLaunchReport({
                    ...report,
                    id: `${report.id}-safe`,
                    status: "safe-mode",
                    message: "No unique culprit was identified; restart in Steamodded-only safe mode."
                });
            }
        };
        window.BalatroWebBridge = {
            stage(payload = {}) {
                activeStage = {
                    stage: String(payload.stage ?? ""),
                    modId: String(payload.modId ?? ""),
                    object: String(payload.object ?? "")
                };
            },
            ready(payload = {}) {
                void record("ready", payload);
            },
            warning(payload = {}) {
                void record("warning", payload);
            },
            crash(payload = {}) {
                void record("crash", payload);
            },
            clipboard: clipboard
        };
        window.BalatroModManager = {
            getMods: getMods,
            prepareGameArchive: prepareGameArchive,
            installArchive: installBrowserArchive,
            deleteMod: deleteMod,
            setModEnabled: setModEnabled
        };
    }
})();
