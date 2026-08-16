class SQLiteParser {
    constructor(arrayBuffer) {
        this.buffer = arrayBuffer;
        this.bytes = new Uint8Array(arrayBuffer);
        this.view = new DataView(arrayBuffer);
        this.textDecoderUtf8 = new TextDecoder('utf-8', { fatal: false });
        this.header = this.parseHeader();
        this.pageSize = this.header.pageSize;
    }

    ensure(offset, length = 1) {
        if (offset < 0 || offset + length > this.bytes.length) {
            throw new RangeError(`Out of bounds: offset=${offset}, length=${length}`);
        }
    }

    readUInt16(offset) {
        this.ensure(offset, 2);
        return this.view.getUint16(offset, false);
    }

    readUInt32(offset) {
        this.ensure(offset, 4);
        return this.view.getUint32(offset, false);
    }

    readInt8(offset) {
        this.ensure(offset, 1);
        return this.view.getInt8(offset);
    }

    readInt16(offset) {
        this.ensure(offset, 2);
        return this.view.getInt16(offset, false);
    }

    readInt32(offset) {
        this.ensure(offset, 4);
        return this.view.getInt32(offset, false);
    }

    readBigIntSigned(offset, length) {
        this.ensure(offset, length);
        let value = 0n;
        for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(this.bytes[offset + i]);
        const bits = BigInt(length * 8);
        const signBit = 1n << (bits - 1n);
        if (value & signBit) value -= 1n << bits;
        return value;
    }

    parseHeader() {
        this.ensure(0, 100);
        const magic = String.fromCharCode(...this.bytes.slice(0, 16));
        if (magic !== 'SQLite format 3\0') throw new Error('유효한 SQLite3 파일이 아닙니다.');

        let pageSize = this.readUInt16(16);
        if (pageSize === 1) pageSize = 65536;

        return {
            magic: 'SQLite format 3',
            pageSize,
            writeVersion: this.bytes[18],
            readVersion: this.bytes[19],
            reservedBytes: this.bytes[20],
            maxEmbeddedPayloadFraction: this.bytes[21],
            minEmbeddedPayloadFraction: this.bytes[22],
            leafPayloadFraction: this.bytes[23],
            fileChangeCounter: this.readUInt32(24),
            databaseSizePages: this.readUInt32(28),
            firstFreelistTrunkPage: this.readUInt32(32),
            freelistPageCount: this.readUInt32(36),
            schemaCookie: this.readUInt32(40),
            schemaFormatNumber: this.readUInt32(44),
            defaultPageCacheSize: this.readUInt32(48),
            largestRootBtreePage: this.readUInt32(52),
            textEncoding: this.readUInt32(56),
            userVersion: this.readUInt32(60),
            incrementalVacuum: this.readUInt32(64),
            applicationId: this.readUInt32(68),
            versionValidFor: this.readUInt32(92),
            sqliteVersionNumber: this.readUInt32(96),
            fileSize: this.bytes.length,
            computedPageCount: Math.ceil(this.bytes.length / pageSize)
        };
    }

    pageOffset(pageNumber) {
        if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error('페이지 번호는 1 이상이어야 합니다.');
        return (pageNumber - 1) * this.pageSize;
    }

    getPageBytes(pageNumber) {
        const start = this.pageOffset(pageNumber);
        this.ensure(start, Math.min(this.pageSize, this.bytes.length - start));
        return this.bytes.slice(start, Math.min(start + this.pageSize, this.bytes.length));
    }

    readVarint(offset) {
        let value = 0n;
        for (let i = 0; i < 9; i++) {
            this.ensure(offset + i, 1);
            const b = this.bytes[offset + i];
            if (i === 8) return { value: (value << 8n) | BigInt(b), length: 9 };
            value = (value << 7n) | BigInt(b & 0x7f);
            if ((b & 0x80) === 0) return { value, length: i + 1 };
        }
        throw new Error('잘못된 varint');
    }

    bigintToSafeNumber(value, label = 'value') {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}가 JavaScript 안전 정수 범위를 초과했습니다.`);
        return Number(value);
    }

    parseBtreePage(pageNumber) {
        const base = this.pageOffset(pageNumber);
        const headerOffset = base + (pageNumber === 1 ? 100 : 0);
        this.ensure(headerOffset, 8);

        const type = this.bytes[headerOffset];
        const interior = type === 0x02 || type === 0x05;
        const leaf = type === 0x0a || type === 0x0d;
        if (!interior && !leaf) {
            return { pageNumber, type, typeName: 'non-btree/unknown', headerOffset, cells: [] };
        }

        const headerSize = interior ? 12 : 8;
        const firstFreeblock = this.readUInt16(headerOffset + 1);
        const cellCount = this.readUInt16(headerOffset + 3);
        let cellContentArea = this.readUInt16(headerOffset + 5);
        if (cellContentArea === 0 && this.pageSize === 65536) cellContentArea = 65536;
        const fragmentedFreeBytes = this.bytes[headerOffset + 7];
        const rightMostPointer = interior ? this.readUInt32(headerOffset + 8) : null;
        const pointerArrayOffset = headerOffset + headerSize;

        const cellPointers = [];
        for (let i = 0; i < cellCount; i++) {
            cellPointers.push(this.readUInt16(pointerArrayOffset + i * 2));
        }

        return {
            pageNumber,
            type,
            typeName: ({ 0x02: 'interior-index', 0x05: 'interior-table', 0x0a: 'leaf-index', 0x0d: 'leaf-table' })[type],
            headerOffset,
            headerSize,
            firstFreeblock,
            cellCount,
            cellContentArea,
            fragmentedFreeBytes,
            rightMostPointer,
            cellPointers
        };
    }

    usableSize() {
        return this.pageSize - this.header.reservedBytes;
    }

    localPayloadSize(payloadSize, pageType) {
        const U = this.usableSize();
        const P = payloadSize;
        const tableLeaf = pageType === 0x0d;
        const X = tableLeaf ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
        const M = Math.floor(((U - 12) * 32) / 255) - 23;
        if (P <= X) return P;
        const K = M + ((P - M) % (U - 4));
        return K <= X ? K : M;
    }

    readPayload(startOffset, payloadSize, pageType) {
        const local = this.localPayloadSize(payloadSize, pageType);
        this.ensure(startOffset, local);
        const chunks = [this.bytes.slice(startOffset, startOffset + local)];
        let remaining = payloadSize - local;
        if (remaining <= 0) return this.concatChunks(chunks, payloadSize);

        this.ensure(startOffset + local, 4);
        let overflowPage = this.readUInt32(startOffset + local);
        const U = this.usableSize();
        const seen = new Set();

        while (remaining > 0 && overflowPage !== 0) {
            if (seen.has(overflowPage)) throw new Error('Overflow page cycle detected');
            seen.add(overflowPage);
            const off = this.pageOffset(overflowPage);
            this.ensure(off, 4);
            const next = this.readUInt32(off);
            const amount = Math.min(remaining, U - 4);
            this.ensure(off + 4, amount);
            chunks.push(this.bytes.slice(off + 4, off + 4 + amount));
            remaining -= amount;
            overflowPage = next;
        }

        if (remaining !== 0) throw new Error('Overflow payload가 중간에 끊겼습니다.');
        return this.concatChunks(chunks, payloadSize);
    }

    concatChunks(chunks, total) {
        const out = new Uint8Array(total);
        let pos = 0;
        for (const chunk of chunks) {
            out.set(chunk, pos);
            pos += chunk.length;
        }
        return out;
    }

    parseTableLeafCell(pageNumber, cellPointer) {
        const pageBase = this.pageOffset(pageNumber);
        let off = pageBase + cellPointer;
        const payloadVar = this.readVarint(off);
        off += payloadVar.length;
        const rowidVar = this.readVarint(off);
        off += rowidVar.length;
        const payloadSize = this.bigintToSafeNumber(payloadVar.value, 'payload size');
        const payload = this.readPayload(off, payloadSize, 0x0d);
        return {
            rowid: rowidVar.value,
            rowidRaw: this.bytes.slice(off - rowidVar.length, off),
            payloadSize,
            record: this.parseRecord(payload)
        };
    }

    parseInteriorTableCell(pageNumber, cellPointer) {
        const off = this.pageOffset(pageNumber) + cellPointer;
        const leftChild = this.readUInt32(off);
        const key = this.readVarint(off + 4);
        return { leftChild, key: key.value };
    }

    parseRecord(payload) {
        const localView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const readLocalVarint = (offset) => {
            let value = 0n;
            for (let i = 0; i < 9; i++) {
                if (offset + i >= payload.length) throw new Error('Record varint out of range');
                const b = payload[offset + i];
                if (i === 8) return { value: (value << 8n) | BigInt(b), length: 9 };
                value = (value << 7n) | BigInt(b & 0x7f);
                if ((b & 0x80) === 0) return { value, length: i + 1 };
            }
            throw new Error('Invalid record varint');
        };

        const headerLenVar = readLocalVarint(0);
        const headerLength = this.bigintToSafeNumber(headerLenVar.value, 'record header length');
        let headerPos = headerLenVar.length;
        const serialTypes = [];
        while (headerPos < headerLength) {
            const serial = readLocalVarint(headerPos);
            serialTypes.push(serial.value);
            headerPos += serial.length;
        }

        let dataPos = headerLength;
        const values = [];
        const fields = [];
        for (const serialType of serialTypes) {
            const decoded = this.decodeSerialType(payload, localView, dataPos, serialType);
            const raw = payload.slice(dataPos, dataPos + decoded.length);
            values.push(decoded.value);
            fields.push({
                serialType,
                offset: dataPos,
                length: decoded.length,
                raw,
                value: decoded.value
            });
            dataPos += decoded.length;
        }
        return { headerLength, serialTypes, values, fields };
    }

    decodeSerialType(payload, view, offset, serialTypeBig) {
        const st = this.bigintToSafeNumber(serialTypeBig, 'serial type');
        const need = (n) => {
            if (offset + n > payload.length) throw new Error('Record payload truncated');
        };

        switch (st) {
            case 0: return { value: null, length: 0 };
            case 1: need(1); return { value: view.getInt8(offset), length: 1 };
            case 2: need(2); return { value: view.getInt16(offset, false), length: 2 };
            case 3: {
                need(3);
                let v = (payload[offset] << 16) | (payload[offset + 1] << 8) | payload[offset + 2];
                if (v & 0x800000) v -= 0x1000000;
                return { value: v, length: 3 };
            }
            case 4: need(4); return { value: view.getInt32(offset, false), length: 4 };
            case 5: need(6); return { value: this.bigIntToDisplay(this.readSignedFromArray(payload, offset, 6)), length: 6 };
            case 6: need(8); return { value: this.bigIntToDisplay(this.readSignedFromArray(payload, offset, 8)), length: 8 };
            case 7: need(8); return { value: view.getFloat64(offset, false), length: 8 };
            case 8: return { value: 0, length: 0 };
            case 9: return { value: 1, length: 0 };
            case 10:
            case 11:
                return { value: `[reserved serial type ${st}]`, length: 0 };
            default: {
                const length = Math.floor((st - (st % 2 === 0 ? 12 : 13)) / 2);
                need(length);
                const raw = payload.slice(offset, offset + length);
                if (st % 2 === 0) return { value: raw, length };
                return { value: this.decodeText(raw), length };
            }
        }
    }

    readSignedFromArray(bytes, offset, length) {
        let value = 0n;
        for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
        const bits = BigInt(length * 8);
        const sign = 1n << (bits - 1n);
        if (value & sign) value -= 1n << bits;
        return value;
    }

    bigIntToDisplay(v) {
        if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
        return v.toString();
    }

    decodeText(raw) {
        const encoding = this.header.textEncoding;
        if (encoding === 2 || encoding === 3) {
            const little = encoding === 2;
            let out = '';
            for (let i = 0; i + 1 < raw.length; i += 2) {
                const code = little ? raw[i] | (raw[i + 1] << 8) : (raw[i] << 8) | raw[i + 1];
                out += String.fromCharCode(code);
            }
            return out;
        }
        return this.textDecoderUtf8.decode(raw);
    }

    toHex(bytes) {
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }

    traverseTable(rootPage, maxRows = 10000) {
        const rows = [];
        const visited = new Set();

        const walk = (pageNumber) => {
            if (rows.length >= maxRows) return;
            if (visited.has(pageNumber)) return;
            visited.add(pageNumber);

            const page = this.parseBtreePage(pageNumber);
            if (page.type === 0x0d) {
                for (const ptr of page.cellPointers) {
                    if (rows.length >= maxRows) break;
                    rows.push(this.parseTableLeafCell(pageNumber, ptr));
                }
            } else if (page.type === 0x05) {
                for (const ptr of page.cellPointers) {
                    const cell = this.parseInteriorTableCell(pageNumber, ptr);
                    walk(cell.leftChild);
                }
                if (page.rightMostPointer) walk(page.rightMostPointer);
            } else {
                throw new Error(`root page ${rootPage}는 table b-tree가 아닙니다 (${page.typeName}).`);
            }
        };

        walk(rootPage);
        return rows;
    }

    parseSchema() {
        const rows = this.traverseTable(1, 10000);
        return rows.map(({ rowid, record }) => {
            const v = record.values;
            return {
                rowid: this.bigIntToDisplay(rowid),
                type: v[0],
                name: v[1],
                tbl_name: v[2],
                rootpage: typeof v[3] === 'number' ? v[3] : Number(v[3]),
                sql: v[4]
            };
        });
    }
}


const $ = (s) => document.querySelector(s);
const fileInput = $('#dbFile');
const openFileButton = $('#openFileButton');
const clearButton = $('#clearButton');
const dropZone = $('#dropZone');
const status = $('#status');
const fileNameView = $('#fileName');
const fileSizeView = $('#fileSize');
const pageCountView = $('#pageCount');
const schemaCountView = $('#schemaCount');
const tableCountView = $('#tableCount');
const recordSummary = $('#recordSummary');
const headerView = $('#headerView');
const schemaView = $('#schemaView');
const tableSelect = $('#tableSelect');
const tableView = $('#tableView');
const inspectPageBtn = $('#inspectPage');
const pageNumberInput = $('#pageNumber');
const pageView = $('#pageView');

let parser = null;
let schema = [];

openFileButton.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
    }
});

for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.add('drag-over');
    });
}
for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.classList.remove('drag-over');
    });
}
dropZone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
});

fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) loadFile(file);
});

clearButton.addEventListener('click', () => {
    parser = null;
    schema = [];
    fileInput.value = '';
    resetViews(true);
});

async function loadFile(file) {
    setStatus(`Parsing ${file.name}...`, '');
    resetViews(false);
    fileNameView.textContent = file.name;
    fileSizeView.textContent = formatFileSize(file.size);

    try {
        const buffer = await file.arrayBuffer();
        parser = new SQLiteParser(buffer);
        schema = parser.parseSchema();
        renderHeader(parser.header);
        renderSchema(schema);
        populateTables(schema);

        const tables = schema.filter(x => x.type === 'table' && x.rootpage > 0 && x.name !== 'sqlite_sequence');
        pageCountView.textContent = String(parser.header.computedPageCount);
        schemaCountView.textContent = String(schema.length);
        tableCountView.textContent = String(tables.length);

        inspectPageBtn.disabled = false;
        pageNumberInput.disabled = false;
        pageNumberInput.max = String(parser.header.computedPageCount);
        clearButton.disabled = false;
        setStatus('Parsed successfully', 'ok');
    } catch (err) {
        console.error(err);
        parser = null;
        setStatus(err?.message || String(err), 'error');
        clearButton.disabled = false;
    }
}

tableSelect.addEventListener('change', () => {
    const name = tableSelect.value;
    for (const card of schemaView.querySelectorAll('.schema-card')) {
        card.classList.toggle('selected', card.dataset.objectName === name);
    }
    if (!name || !parser) {
        recordSummary.textContent = 'Select a table to inspect records.';
        tableView.className = 'empty main-empty';
        tableView.textContent = 'Select a table to display records.';
        return;
    }
    const entry = schema.find(x => x.type === 'table' && x.name === name);
    if (!entry) return;

    try {
        const rows = parser.traverseTable(entry.rootpage, 10000);
        renderRows(entry, rows);
        recordSummary.textContent = `${entry.name} · root ${entry.rootpage} · ${rows.length} rows`;
    } catch (err) {
        tableView.className = 'empty main-empty';
        tableView.textContent = err?.message || String(err);
        recordSummary.textContent = 'Unable to read table.';
    }
});

inspectPageBtn.addEventListener('click', inspectCurrentPage);
pageNumberInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') inspectCurrentPage();
});

function inspectCurrentPage() {
    if (!parser) return;
    const n = Number(pageNumberInput.value);
    try {
        const page = parser.parseBtreePage(n);
        const raw = parser.getPageBytes(n);
        pageView.textContent = JSON.stringify({
            ...page,
            previewHex: parser.toHex(raw.slice(0, 128))
        }, bigintReplacer, 2);
    } catch (err) {
        pageView.textContent = err?.message || String(err);
    }
}

function resetViews(fullReset = false) {
    headerView.className = 'kv-list empty';
    headerView.textContent = fullReset ? 'No data loaded.' : 'Parsing...';
    schemaView.className = 'empty';
    schemaView.textContent = fullReset ? 'No data loaded.' : 'Parsing...';
    tableView.className = 'empty main-empty';
    tableView.textContent = 'Select a table to display records.';
    tableSelect.innerHTML = '<option value="">Select table</option>';
    tableSelect.disabled = true;
    inspectPageBtn.disabled = true;
    pageNumberInput.disabled = true;
    pageNumberInput.value = '1';
    pageView.textContent = 'No data loaded.';
    recordSummary.textContent = 'Select a table to inspect records.';

    if (fullReset) {
        fileNameView.textContent = 'No file loaded';
        fileSizeView.textContent = '-';
        pageCountView.textContent = '0';
        schemaCountView.textContent = '0';
        tableCountView.textContent = '0';
        clearButton.disabled = true;
        setStatus('Ready', '');
    }
}

function setStatus(message, state) {
    status.className = `drop-zone-status${state ? ` ${state}` : ''}`;
    status.textContent = message;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function renderHeader(header) {
    headerView.className = 'kv-list';
    headerView.innerHTML = '';
    const encodingNames = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' };
    const entries = {
        ...header,
        textEncoding: `${header.textEncoding} (${encodingNames[header.textEncoding] || 'unknown'})`
    };
    for (const [key, value] of Object.entries(entries)) {
        const k = document.createElement('div');
        k.className = 'key';
        k.textContent = key;
        const v = document.createElement('div');
        v.className = 'value';
        v.textContent = String(value);
        headerView.append(k, v);
    }
}

function renderSchema(entries) {
    schemaView.className = '';
    schemaView.innerHTML = '';
    if (!entries.length) {
        schemaView.className = 'empty';
        schemaView.textContent = 'No schema entries.';
        return;
    }

    const ordered = [...entries].sort((a, b) => {
        const rank = { table: 0, view: 1, index: 2, trigger: 3 };
        return (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || a.name.localeCompare(b.name);
    });

    for (const entry of ordered) {
        const card = document.createElement('div');
        card.className = `schema-card ${entry.type === 'table' ? 'table-object' : ''}`;
        card.dataset.objectName = entry.name;

        const title = document.createElement('strong');
        title.textContent = entry.name;

        const code = document.createElement('code');
        code.textContent = `${entry.type.toUpperCase()} · root ${entry.rootpage || 0}`;
        code.title = entry.sql || '(no SQL)';
        card.append(title, code);

        if (entry.type === 'table' && entry.rootpage > 0 && entry.name !== 'sqlite_sequence') {
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.addEventListener('click', () => selectTableFromExplorer(entry.name));
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectTableFromExplorer(entry.name);
                }
            });
        }

        schemaView.append(card);
    }
}

function selectTableFromExplorer(name) {
    if (!tableSelect || tableSelect.disabled) return;
    tableSelect.value = name;
    tableSelect.dispatchEvent(new Event('change'));
    for (const card of schemaView.querySelectorAll('.schema-card')) {
        card.classList.toggle('selected', card.dataset.objectName === name);
    }
}

function populateTables(entries) {
    const tables = entries.filter(x => x.type === 'table' && x.rootpage > 0 && x.name !== 'sqlite_sequence');
    tableSelect.innerHTML = '<option value="">Select table</option>';
    for (const table of tables) {
        const option = document.createElement('option');
        option.value = table.name;
        option.textContent = `${table.name} · root ${table.rootpage}`;
        tableSelect.append(option);
    }
    tableSelect.disabled = tables.length === 0;
}

function renderRows(entry, rows) {
    tableView.className = 'table-wrap';
    tableView.innerHTML = '';

    if (!rows.length) {
        tableView.className = 'empty main-empty';
        tableView.textContent = 'No records.';
        return;
    }

    const columnNames = inferColumnNames(entry.sql, rows[0].record.values.length);
    const integerPkIndex = inferIntegerPrimaryKeyIndex(entry.sql, columnNames);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    for (const name of ['rowid', ...columnNames]) {
        const th = document.createElement('th');
        th.textContent = name;
        trh.append(th);
    }
    thead.append(trh);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        const rid = document.createElement('td');
        rid.textContent = String(typeof row.rowid === 'bigint' ? row.rowid.toString() : row.rowid);
        tr.append(rid);

        for (let i = 0; i < row.record.values.length; i++) {
            let value = row.record.values[i];
            if (i === integerPkIndex && value === null) value = row.rowid;
            const td = document.createElement('td');
            td.textContent = formatValue(value);
            td.title = td.textContent;
            tr.append(td);
        }
        tbody.append(tr);
    }
    table.append(tbody);
    tableView.append(table);
}

function inferColumnNames(sql, count) {
    if (!sql || typeof sql !== 'string') return Array.from({ length: count }, (_, i) => `column_${i + 1}`);
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    if (open < 0 || close <= open) return Array.from({ length: count }, (_, i) => `column_${i + 1}`);

    const body = sql.slice(open + 1, close);
    const parts = splitSqlList(body);
    const names = [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(trimmed)) continue;
        const m = trimmed.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([^\s]+))/);
        if (m) names.push(m[1] || m[2] || m[3] || m[4]);
    }
    while (names.length < count) names.push(`column_${names.length + 1}`);
    return names.slice(0, count);
}

function inferIntegerPrimaryKeyIndex(sql, columnNames) {
    if (!sql || typeof sql !== 'string') return -1;
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    if (open < 0 || close <= open) return -1;
    const parts = splitSqlList(sql.slice(open + 1, close));
    let columnIndex = -1;
    for (const part of parts) {
        const trimmed = part.trim();
        if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(trimmed)) continue;
        columnIndex++;
        if (/\binteger\s+primary\s+key\b/i.test(trimmed)) return columnIndex;
    }
    return -1;
}

function splitSqlList(text) {
    const parts = [];
    let start = 0, depth = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote && text[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '[') { quote = ']'; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

function formatValue(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return `BLOB(${value.length}) ${parser?.toHex(value.slice(0, 32)) || ''}${value.length > 32 ? ' …' : ''}`;
    return String(value);
}

function bigintReplacer(key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}

// --- SQL console + RAW hex viewer -------------------------------------------------
const viewTabs = [...document.querySelectorAll('.view-tab[data-view]')];
const dataPanel = $('#dataPanel');
const sqlPanel = $('#sqlPanel');
const rawPanel = $('#rawPanel');
const sqlInput = $('#sqlInput');
const runSqlButton = $('#runSqlButton');
const clearSqlButton = $('#clearSqlButton');
const sqlResult = $('#sqlResult');
const rawSource = $('#rawSource');
const rawOffset = $('#rawOffset');
const rawLength = $('#rawLength');
const rawPage = $('#rawPage');
const renderRawButton = $('#renderRawButton');
const rawView = $('#rawView');
const rawMeta = $('#rawMeta');
let selectedBlob = null;

function switchView(name) {
    for (const tab of viewTabs) tab.classList.toggle('active', tab.dataset.view === name);
    dataPanel.classList.toggle('active', name === 'data');
    sqlPanel.classList.toggle('active', name === 'sql');
    rawPanel.classList.toggle('active', name === 'raw');
}
viewTabs.forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));
clearSqlButton.addEventListener('click', () => { sqlInput.value = ''; sqlResult.textContent = ''; });
runSqlButton.addEventListener('click', executeSql);
sqlInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); executeSql(); } });
renderRawButton.addEventListener('click', renderRaw);
rawSource.addEventListener('change', renderRaw);

function enableAdvancedViews(enabled) {
    runSqlButton.disabled = !enabled;
    rawSource.disabled = !enabled;
    rawOffset.disabled = !enabled;
    rawLength.disabled = !enabled;
    rawPage.disabled = !enabled;
    renderRawButton.disabled = !enabled;
}

function parseSqlLiteral(text) {
    const s = text.trim();
    if (/^null$/i.test(s)) return null;
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
    if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/^'(.*)'$/s) || s.match(/^"(.*)"$/s);
    return m ? m[1].replace(/''/g, "'") : s;
}

function executeSql() {
    if (!parser) return;
    const query = sqlInput.value.trim().replace(/;\s*$/, '');
    try {
        const m = query.match(/^select\s+(.+?)\s+from\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))(?:\s+where\s+(.+?))?(?:\s+limit\s+(\d+))?$/is);
        if (!m) throw new Error('Supported syntax: SELECT columns FROM table [WHERE column = value] [LIMIT n]');
        const columnExpr = m[1].trim();
        const tableName = m[2] || m[3] || m[4] || m[5];
        const whereExpr = m[6]?.trim() || '';
        const limit = Math.min(Number(m[7] || 1000), 10000);

        let columns, objects;
        if (/^(sqlite_schema|sqlite_master)$/i.test(tableName)) {
            columns = ['rowid', 'type', 'name', 'tbl_name', 'rootpage', 'sql'];
            objects = schema.map(x => ({ rowid: x.rowid, type: x.type, name: x.name, tbl_name: x.tbl_name, rootpage: x.rootpage, sql: x.sql }));
        } else {
            const entry = schema.find(x => x.type === 'table' && x.name.toLowerCase() === tableName.toLowerCase());
            if (!entry) throw new Error(`Table not found: ${tableName}`);
            const rows = parser.traverseTable(entry.rootpage, 10000);
            const names = inferColumnNames(entry.sql, rows[0]?.record.values.length || 0);
            const pk = inferIntegerPrimaryKeyIndex(entry.sql, names);
            columns = ['rowid', ...names];
            objects = rows.map(row => {
                const o = { rowid: row.rowid };
                names.forEach((n, i) => { let v = row.record.values[i]; if (i === pk && v === null) v = row.rowid; o[n] = v; });
                return o;
            });
        }

        if (whereExpr) {
            const wm = whereExpr.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w$]+))\s*(=|!=|<>)\s*(.+)$/s);
            if (!wm) throw new Error('WHERE currently supports only column = value or != value.');
            const key = wm[1] || wm[2] || wm[3] || wm[4], op = wm[5], expected = parseSqlLiteral(wm[6]);
            objects = objects.filter(o => { const v = o[key]; const eq = (typeof v === 'bigint' ? v.toString() : v) == expected; return op === '=' ? eq : !eq; });
        }

        let selected;
        if (columnExpr === '*') selected = columns;
        else selected = splitSqlList(columnExpr).map(x => x.trim().replace(/^["`\[]|["`\]]$/g, ''));
        for (const c of selected) if (!columns.includes(c)) throw new Error(`Unknown column: ${c}`);
        renderObjectGrid(sqlResult, selected, objects.slice(0, limit));
    } catch (err) {
        sqlResult.className = 'sql-result empty';
        sqlResult.textContent = err?.message || String(err);
    }
}

function renderObjectGrid(container, columns, rows) {
    container.className = 'sql-result table-wrap'; container.innerHTML = '';
    if (!rows.length) { container.className = 'sql-result empty'; container.textContent = '0 rows'; return; }
    const table = document.createElement('table'), thead = document.createElement('thead'), hr = document.createElement('tr');
    columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; hr.append(th) }); thead.append(hr); table.append(thead);
    const tbody = document.createElement('tbody');
    rows.forEach(o => { const tr = document.createElement('tr'); columns.forEach(c => { const td = document.createElement('td'); renderCellValue(td, o[c]); tr.append(td) }); tbody.append(tr) }); table.append(tbody); container.append(table);
}

function renderCellValue(td, value) {
    td.textContent = formatValue(value); td.title = td.textContent;
    if (value instanceof Uint8Array) {
        td.classList.add('blob-cell');
        td.title = 'Click to open this BLOB in RAW viewer';
        td.addEventListener('click', () => { selectedBlob = value; rawSource.value = 'blob'; switchView('raw'); renderRaw(); });
    }
}

function hexDump(bytes, baseOffset = 0) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16);
        const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const ascii = [...chunk].map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('');
        lines.push(`${(baseOffset + i).toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
    }
    return lines.join('\n');
}

function renderRaw() {
    if (!parser) return;
    try {
        const source = rawSource.value; let bytes, base = 0, label = '';
        if (source === 'blob') {
            if (!selectedBlob) throw new Error('No BLOB selected. Click a BLOB cell in Data/SQL view first.');
            const off = Math.max(0, Number(rawOffset.value) || 0), len = Math.max(1, Number(rawLength.value) || 512);
            bytes = selectedBlob.slice(off, off + len); base = off; label = `BLOB · ${selectedBlob.length} bytes`;
        } else if (source === 'page') {
            const page = Math.max(1, Number(rawPage.value) || 1); const pageBytes = parser.getPageBytes(page);
            const off = Math.max(0, Number(rawOffset.value) || 0), len = Math.max(1, Number(rawLength.value) || 512);
            bytes = pageBytes.slice(off, off + len); base = parser.pageOffset(page) + off; label = `Page ${page} · file offset 0x${parser.pageOffset(page).toString(16)}`;
        } else {
            const off = Math.max(0, Number(rawOffset.value) || 0), len = Math.max(1, Number(rawLength.value) || 512);
            bytes = parser.bytes.slice(off, off + len); base = off; label = `File · ${parser.bytes.length} bytes`;
        }
        rawView.textContent = hexDump(bytes, base); rawMeta.textContent = `${label} · showing ${bytes.length} bytes`;
    } catch (err) { rawView.textContent = err?.message || String(err); rawMeta.textContent = 'Error'; }
}

// Hook existing lifecycle/renderers without changing parser internals.
const _originalLoadFile = loadFile;
loadFile = async function (file) { await _originalLoadFile(file); enableAdvancedViews(!!parser); if (parser) { rawPage.max = String(parser.header.computedPageCount); renderRaw(); } };
const _originalResetViews = resetViews;
resetViews = function (fullReset = false) { _originalResetViews(fullReset); enableAdvancedViews(false); selectedBlob = null; rawView.textContent = 'No data loaded.'; rawMeta.textContent = 'No data'; sqlResult.className = 'sql-result empty'; sqlResult.textContent = 'Open a database and run a SELECT query.'; };

// Enhance the main record grid so BLOB cells are clickable.
const _originalRenderRows = renderRows;
renderRows = function (entry, rows) {
    _originalRenderRows(entry, rows);
    const cells = [...tableView.querySelectorAll('tbody td')];
    if (!rows.length) return;
    const names = inferColumnNames(entry.sql, rows[0].record.values.length);
    const pk = inferIntegerPrimaryKeyIndex(entry.sql, names);
    let k = 0;
    rows.forEach(row => { k++; for (let i = 0; i < row.record.values.length; i++) { let v = row.record.values[i]; if (i === pk && v === null) v = row.rowid; const td = cells[k++]; if (v instanceof Uint8Array && td) { td.classList.add('blob-cell'); td.title = 'Click to open this BLOB in RAW viewer'; td.addEventListener('click', () => { selectedBlob = v; rawSource.value = 'blob'; switchView('raw'); renderRaw(); }); } } });
};

// --- Per-cell RAW side inspector -------------------------------------------------
const cellInspectorHint = $('#cellInspectorHint');
const cellTable = $('#cellTable');
const cellColumn = $('#cellColumn');
const cellRowid = $('#cellRowid');
const cellType = $('#cellType');
const cellSerial = $('#cellSerial');
const cellLength = $('#cellLength');
const cellHex = $('#cellHex');
const cellAscii = $('#cellAscii');
const cellValue = $('#cellValue');
const clearCellSelection = $('#clearCellSelection');
let selectedRawCell = null;

function serialTypeLabel(serialType) {
    if (serialType === 'rowid') return 'ROWID varint';
    const st = typeof serialType === 'bigint' ? Number(serialType) : Number(serialType);
    if (st === 0) return 'NULL';
    if (st === 1) return 'INTEGER (8-bit)';
    if (st === 2) return 'INTEGER (16-bit)';
    if (st === 3) return 'INTEGER (24-bit)';
    if (st === 4) return 'INTEGER (32-bit)';
    if (st === 5) return 'INTEGER (48-bit)';
    if (st === 6) return 'INTEGER (64-bit)';
    if (st === 7) return 'REAL (64-bit)';
    if (st === 8) return 'INTEGER 0';
    if (st === 9) return 'INTEGER 1';
    if (st === 10 || st === 11) return 'RESERVED';
    if (st >= 12) return st % 2 === 0 ? 'BLOB' : 'TEXT';
    return 'UNKNOWN';
}

function bytesToSpacedHex(bytes) {
    return [...(bytes || [])].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function bytesToAscii(bytes) {
    return [...(bytes || [])].map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
}

function rawValueText(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return bytesToSpacedHex(value);
    return String(value);
}

function clearRawCellInspector() {
    selectedRawCell = null;
    tableView.querySelectorAll('.cell-raw-selected').forEach(el => el.classList.remove('cell-raw-selected'));
    cellInspectorHint.textContent = 'Click any cell';
    cellTable.textContent = '—';
    cellColumn.textContent = '—';
    cellRowid.textContent = '—';
    cellType.textContent = '—';
    cellSerial.textContent = '—';
    cellLength.textContent = '0';
    cellHex.value = '';
    cellAscii.value = '';
    cellValue.value = '';
    clearCellSelection.disabled = true;
}

function showRawCellInspector(meta, td) {
    tableView.querySelectorAll('.cell-raw-selected').forEach(el => el.classList.remove('cell-raw-selected'));
    td.classList.add('cell-raw-selected');
    selectedRawCell = meta;

    const raw = meta.raw || new Uint8Array();
    const serialDisplay = meta.serialType === 'rowid'
        ? 'rowid varint'
        : String(typeof meta.serialType === 'bigint' ? meta.serialType.toString() : meta.serialType);

    cellInspectorHint.textContent = `${meta.column} · ${raw.length} byte${raw.length === 1 ? '' : 's'}`;
    cellTable.textContent = meta.table || '—';
    cellColumn.textContent = meta.column || '—';
    cellRowid.textContent = meta.rowid == null ? '—' : String(meta.rowid);
    cellType.textContent = serialTypeLabel(meta.serialType);
    cellSerial.textContent = serialDisplay;
    cellLength.textContent = String(raw.length);
    cellHex.value = bytesToSpacedHex(raw);
    cellAscii.value = bytesToAscii(raw);
    cellValue.value = rawValueText(meta.value);
    clearCellSelection.disabled = false;
}

async function copyTextFromElement(id, button) {
    const el = document.getElementById(id);
    const text = el?.value ?? el?.textContent ?? '';
    if (!text) return;
    let copied = false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
    } catch (_) { }
    if (!copied && el && typeof el.select === 'function') {
        el.focus();
        el.select();
        try { copied = document.execCommand('copy'); } catch (_) { }
        if (window.getSelection) window.getSelection()?.removeAllRanges();
    }
    const old = button.textContent;
    button.textContent = copied ? 'Copied' : 'Select';
    setTimeout(() => { button.textContent = old; }, 900);
}

document.querySelectorAll('.copy-btn[data-copy-target]').forEach(button => {
    button.addEventListener('click', () => copyTextFromElement(button.dataset.copyTarget, button));
});
clearCellSelection.addEventListener('click', clearRawCellInspector);

// Replace the record-grid renderer so every individual cell carries its own raw bytes.
renderRows = function (entry, rows) {
    tableView.className = 'table-wrap';
    tableView.innerHTML = '';
    clearRawCellInspector();

    if (!rows.length) {
        tableView.className = 'empty main-empty';
        tableView.textContent = 'No records.';
        return;
    }

    const columnNames = inferColumnNames(entry.sql, rows[0].record.values.length);
    const integerPkIndex = inferIntegerPrimaryKeyIndex(entry.sql, columnNames);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    for (const name of ['rowid', ...columnNames]) {
        const th = document.createElement('th');
        th.textContent = name;
        trh.append(th);
    }
    thead.append(trh);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
        const rowidText = typeof row.rowid === 'bigint' ? row.rowid.toString() : String(row.rowid);
        const tr = document.createElement('tr');

        const rid = document.createElement('td');
        rid.textContent = rowidText;
        rid.title = 'Click to inspect the rowid varint bytes';
        rid.classList.add('cell-raw-selectable');
        if (cellMatchesSearch(row.rowid)) rid.classList.add('cell-search-hit');
        rid.addEventListener('click', () => showRawCellInspector({
            table: entry.name,
            column: 'rowid',
            rowid: rowidText,
            serialType: 'rowid',
            raw: row.rowidRaw || new Uint8Array(),
            value: row.rowid
        }, rid));
        tr.append(rid);

        for (let i = 0; i < row.record.values.length; i++) {
            const storedValue = row.record.values[i];
            const field = row.record.fields?.[i] || {
                serialType: row.record.serialTypes?.[i] ?? 0n,
                raw: new Uint8Array(),
                length: 0,
                value: storedValue
            };
            const isIntegerPkAlias = i === integerPkIndex && storedValue === null;
            const value = isIntegerPkAlias ? row.rowid : storedValue;
            const td = document.createElement('td');
            td.textContent = formatValue(value);
            td.title = 'Click to inspect this cell raw bytes';
            td.classList.add('cell-raw-selectable');
            if (cellMatchesSearch(value)) td.classList.add('cell-search-hit');
            if (value === null) td.classList.add('cell-type-null');
            if (storedValue instanceof Uint8Array) td.classList.add('cell-type-blob');

            // INTEGER PRIMARY KEY is stored as NULL in the record body; its value is the rowid.
            // For the displayed cell, show the rowid varint bytes because those are the bytes
            // that actually carry the visible integer value in a rowid table.
            const rawMeta = isIntegerPkAlias ? {
                table: entry.name,
                column: columnNames[i],
                rowid: rowidText,
                serialType: 'rowid',
                raw: row.rowidRaw || new Uint8Array(),
                value: row.rowid
            } : {
                table: entry.name,
                column: columnNames[i],
                rowid: rowidText,
                serialType: field.serialType,
                raw: field.raw || new Uint8Array(),
                value
            };

            td.addEventListener('click', () => {
                if (storedValue instanceof Uint8Array) selectedBlob = storedValue;
                showRawCellInspector(rawMeta, td);
            });
            tr.append(td);
        }
        tbody.append(tr);
    }
    table.append(tbody);
    tableView.append(table);
};

// Keep the side inspector synchronized with database lifecycle resets.
const _resetViewsWithAdvancedPanels = resetViews;
resetViews = function (fullReset = false) {
    _resetViewsWithAdvancedPanels(fullReset);
    clearRawCellInspector();
};

// --- Main record pagination ------------------------------------------------------
const firstPageButton = $('#firstPageButton');
const prevPageButton = $('#prevPageButton');
const nextPageButton = $('#nextPageButton');
const lastPageButton = $('#lastPageButton');
const pageIndicator = $('#pageIndicator');
const dataPageSize = $('#dataPageSize');
const dataSearchInput = $('#dataSearchInput');
const clearDataSearch = $('#clearDataSearch');
const searchResultCount = $('#searchResultCount');

let pagedEntry = null;
let allDataRows = [];
let pagedRows = [];
let dataPage = 1;
let rowsPerPage = 100;
let dataSearchQuery = '';
let dataSearchTimer = null;
let rowSearchCache = new WeakMap();

function bytesToSearchText(bytes) {
    if (!(bytes instanceof Uint8Array)) return '';
    let hex = '';
    let ascii = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        hex += b.toString(16).padStart(2, '0');
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
    }
    return `${hex} ${ascii}`;
}

function valueToSearchText(value) {
    if (value === null || value === undefined) return 'null';
    if (value instanceof Uint8Array) return bytesToSearchText(value);
    if (typeof value === 'bigint') return value.toString();
    return String(value);
}

function rowSearchText(row) {
    const cached = rowSearchCache.get(row);
    if (cached !== undefined) return cached;
    const parts = [valueToSearchText(row.rowid)];
    for (const value of row.record?.values || []) parts.push(valueToSearchText(value));
    const text = parts.join(' ').toLocaleLowerCase();
    rowSearchCache.set(row, text);
    return text;
}

function queryTokens() {
    return dataSearchQuery.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function rowMatchesSearch(row, tokens) {
    if (!tokens.length) return true;
    const haystack = rowSearchText(row);
    return tokens.every(token => haystack.includes(token));
}

function cellMatchesSearch(value) {
    const tokens = queryTokens();
    if (!tokens.length) return false;
    const haystack = valueToSearchText(value).toLocaleLowerCase();
    return tokens.some(token => haystack.includes(token));
}

function applyDataSearch({ render = true } = {}) {
    const tokens = queryTokens();
    pagedRows = tokens.length ? allDataRows.filter(row => rowMatchesSearch(row, tokens)) : allDataRows;
    dataPage = 1;
    clearDataSearch.disabled = !dataSearchQuery;
    searchResultCount.textContent = tokens.length ? `${pagedRows.length.toLocaleString()} / ${allDataRows.length.toLocaleString()}` : '';
    if (render) renderCurrentDataPage();
}

function totalDataPages() {
    return pagedRows.length ? Math.ceil(pagedRows.length / rowsPerPage) : 0;
}

function updateDataPager() {
    const totalPages = totalDataPages();
    if (totalPages === 0) dataPage = 1;
    else dataPage = Math.max(1, Math.min(dataPage, totalPages));

    pageIndicator.textContent = totalPages ? `Page ${dataPage} / ${totalPages}` : 'Page 0 / 0';
    const disabled = totalPages <= 1;
    firstPageButton.disabled = disabled || dataPage <= 1;
    prevPageButton.disabled = disabled || dataPage <= 1;
    nextPageButton.disabled = disabled || dataPage >= totalPages;
    lastPageButton.disabled = disabled || dataPage >= totalPages;
    dataPageSize.disabled = !pagedEntry;
    dataSearchInput.disabled = !pagedEntry;
    clearDataSearch.disabled = !pagedEntry || !dataSearchQuery;
}

function renderCurrentDataPage() {
    tableView.className = 'table-wrap';
    tableView.innerHTML = '';
    clearRawCellInspector();

    if (!pagedEntry || !pagedRows.length) {
        tableView.className = 'empty main-empty';
        tableView.textContent = pagedEntry
            ? (dataSearchQuery ? `No records match “${dataSearchQuery}”.` : 'No records.')
            : 'Select a table to display records.';
        recordSummary.textContent = pagedEntry
            ? `${pagedEntry.name} · root ${pagedEntry.rootpage} · ${dataSearchQuery ? `0 matches of ${allDataRows.length}` : '0 rows'}`
            : 'Select a table to inspect records.';
        updateDataPager();
        return;
    }

    const totalPages = totalDataPages();
    dataPage = Math.max(1, Math.min(dataPage, totalPages));
    const start = (dataPage - 1) * rowsPerPage;
    const end = Math.min(start + rowsPerPage, pagedRows.length);
    const rows = pagedRows.slice(start, end);
    const entry = pagedEntry;

    const columnNames = inferColumnNames(entry.sql, pagedRows[0].record.values.length);
    const integerPkIndex = inferIntegerPrimaryKeyIndex(entry.sql, columnNames);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');

    for (const name of ['rowid', ...columnNames]) {
        const th = document.createElement('th');
        th.textContent = name;
        trh.append(th);
    }
    thead.append(trh);
    table.append(thead);

    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
        const rowidText = typeof row.rowid === 'bigint' ? row.rowid.toString() : String(row.rowid);
        const tr = document.createElement('tr');

        const rid = document.createElement('td');
        rid.textContent = rowidText;
        rid.title = 'Click to inspect the rowid varint bytes';
        rid.classList.add('cell-raw-selectable');
        rid.addEventListener('click', () => showRawCellInspector({
            table: entry.name,
            column: 'rowid',
            rowid: rowidText,
            serialType: 'rowid',
            raw: row.rowidRaw || new Uint8Array(),
            value: row.rowid
        }, rid));
        tr.append(rid);

        for (let i = 0; i < row.record.values.length; i++) {
            const storedValue = row.record.values[i];
            const field = row.record.fields?.[i] || {
                serialType: row.record.serialTypes?.[i] ?? 0n,
                raw: new Uint8Array(),
                length: 0,
                value: storedValue
            };
            const isIntegerPkAlias = i === integerPkIndex && storedValue === null;
            const value = isIntegerPkAlias ? row.rowid : storedValue;
            const td = document.createElement('td');
            td.textContent = formatValue(value);
            td.title = 'Click to inspect this cell raw bytes';
            td.classList.add('cell-raw-selectable');
            if (value === null) td.classList.add('cell-type-null');
            if (storedValue instanceof Uint8Array) td.classList.add('cell-type-blob');

            const rawMeta = isIntegerPkAlias ? {
                table: entry.name,
                column: columnNames[i],
                rowid: rowidText,
                serialType: 'rowid',
                raw: row.rowidRaw || new Uint8Array(),
                value: row.rowid
            } : {
                table: entry.name,
                column: columnNames[i],
                rowid: rowidText,
                serialType: field.serialType,
                raw: field.raw || new Uint8Array(),
                value
            };

            td.addEventListener('click', () => {
                if (storedValue instanceof Uint8Array) selectedBlob = storedValue;
                showRawCellInspector(rawMeta, td);
            });
            tr.append(td);
        }
        fragment.append(tr);
    }
    tbody.append(fragment);
    table.append(tbody);
    tableView.append(table);

    recordSummary.textContent = dataSearchQuery
        ? `${entry.name} · ${pagedRows.length} matches of ${allDataRows.length} · showing ${start + 1}–${end}`
        : `${entry.name} · root ${entry.rootpage} · rows ${start + 1}–${end} of ${pagedRows.length}`;
    updateDataPager();
    tableView.scrollTop = 0;
    tableView.scrollLeft = 0;
}

// This is the public table renderer used by table selection. It now stores the
// parsed rows once and only materializes one page of DOM nodes at a time.
renderRows = function (entry, rows) {
    pagedEntry = entry;
    allDataRows = rows;
    pagedRows = rows;
    dataPage = 1;
    rowsPerPage = Number(dataPageSize.value) || 100;
    dataSearchQuery = '';
    dataSearchInput.value = '';
    searchResultCount.textContent = '';
    rowSearchCache = new WeakMap();
    renderCurrentDataPage();
};

function goToDataPage(page) {
    const totalPages = totalDataPages();
    if (!totalPages) return;
    const next = Math.max(1, Math.min(page, totalPages));
    if (next === dataPage) return;
    dataPage = next;
    renderCurrentDataPage();
}

firstPageButton.addEventListener('click', () => goToDataPage(1));
prevPageButton.addEventListener('click', () => goToDataPage(dataPage - 1));
nextPageButton.addEventListener('click', () => goToDataPage(dataPage + 1));
lastPageButton.addEventListener('click', () => goToDataPage(totalDataPages()));
dataPageSize.addEventListener('change', () => {
    rowsPerPage = Number(dataPageSize.value) || 100;
    dataPage = 1;
    renderCurrentDataPage();
});

dataSearchInput.addEventListener('input', () => {
    dataSearchQuery = dataSearchInput.value.trim();
    clearTimeout(dataSearchTimer);
    dataSearchTimer = setTimeout(() => applyDataSearch(), 180);
});

dataSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dataSearchInput.value) {
        event.preventDefault();
        dataSearchInput.value = '';
        dataSearchQuery = '';
        clearTimeout(dataSearchTimer);
        applyDataSearch();
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(dataSearchTimer);
        dataSearchQuery = dataSearchInput.value.trim();
        applyDataSearch();
    }
});

clearDataSearch.addEventListener('click', () => {
    dataSearchInput.value = '';
    dataSearchQuery = '';
    clearTimeout(dataSearchTimer);
    applyDataSearch();
    dataSearchInput.focus();
});

// Ctrl/Cmd+F focuses the table search while the Data tab is active.
document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
        const dataPanel = $('#dataPanel');
        if (dataPanel?.classList.contains('active') && !dataSearchInput.disabled) {
            event.preventDefault();
            dataSearchInput.focus();
            dataSearchInput.select();
        }
    }
});

// Reset pagination state together with the rest of the viewer.
const _resetViewsWithCellInspector = resetViews;
resetViews = function (fullReset = false) {
    _resetViewsWithCellInspector(fullReset);
    pagedEntry = null;
    allDataRows = [];
    pagedRows = [];
    dataPage = 1;
    rowsPerPage = Number(dataPageSize.value) || 100;
    dataSearchQuery = '';
    dataSearchInput.value = '';
    searchResultCount.textContent = '';
    rowSearchCache = new WeakMap();
    updateDataPager();
};

updateDataPager();
