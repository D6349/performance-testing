// Minimal Open XML workbook packaging using Node built-ins only.
import { Buffer } from 'node:buffer';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export const STYLES = Object.freeze({ normal: 0, title: 1, subtitle: 2, header: 3, text: 4, number: 5, percent: 6, integer: 7, pass: 8, fail: 9, missing: 10, note: 11, section: 12, cardLabel: 13, cardNumber: 14, cardInteger: 15, cardPercent: 16, cardText: 17, label: 18, link: 19, cardPass: 20, cardFail: 21, banner: 22 });
export function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/_x([0-9a-f]{4})_/gi, '_x005F_x$1_')
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}
export function columnName(index) {
  let result = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// Stored ZIP entries keep output independently inspectable, with no ZIP64,
// external data links, formulas, macros, executables, or compression dependency.
export function zipEntries(entries) {
  const local = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_./\[\]-]+$/.test(name) || name.includes('..')) throw new Error('Invalid workbook package path');
    const filename = Buffer.from(name, 'utf8');
    const bytes = Buffer.from(content, 'utf8');
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // 1980-01-01: deterministic ZIP metadata.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + bytes.length;
    if (offset > 64 * 1024 * 1024) throw new Error('Workbook exceeds the supported size limit');
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function stylesXml() {
  const font = (size, color, bold = false, underline = false) => `<font>${bold ? '<b/>' : ''}${underline ? '<u/>' : ''}<sz val="${size}"/><color rgb="FF${color}"/><name val="Calibri"/><family val="2"/></font>`;
  const fonts = [font(11, '172B4D'), font(24, 'FFFFFF', true), font(11, 'FFFFFF', true), font(10, '52647A'), font(26, '102A43', true), font(11, '166534', true), font(11, '991B1B', true), font(11, '92400E', true), font(12, '102A43', true), font(11, '0369A1', false, true), font(11, '102A43', true), font(26, '166534', true), font(26, '991B1B', true)];
  const fill = color => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`;
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', fill('102A43'), fill('EAF3FA'), fill('DCFCE7'), fill('FEE2E2'), fill('FEF3C7'), fill('0F766E'), fill('FFFFFF'), fill('F3F6FA')];
  const xf = (fontId, fillId, borderId = 0, numFmtId = 0, horizontal = 'left', wrap = false) => `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="${horizontal}" vertical="center"${wrap ? ' wrapText="1"' : ''}/></xf>`;
  const formats = [
    xf(0,0), xf(1,2), xf(3,0), xf(2,2,1,0,'left',true), xf(0,0,1,0,'left',true),
    xf(0,0,1,164,'right'), xf(0,0,1,165,'right'), xf(0,0,1,166,'right'),
    xf(5,4,1,0,'center'), xf(6,5,1,0,'center'), xf(7,6,1,0,'center',true),
    xf(3,9,0,0,'left',true), xf(8,3), xf(3,3), xf(4,3,0,164,'center'),
    xf(4,3,0,166,'center'), xf(4,3,0,165,'center'), xf(4,3,0,0,'center'),
    xf(10,0,1), xf(9,3,0,0,'center'), xf(11,4,0,0,'center'), xf(12,5,0,0,'center'), xf(3,3,0,0,'left',true)
  ];
  return DECL + `<styleSheet xmlns="${MAIN}"><numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts><fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${formats.length}">${formats.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
}
function cellXml(cell, row) {
  const reference = columnName(cell.column) + row;
  const prefix = `<c r="${reference}" s="${cell.style ?? 0}"`;
  if (cell.value === null || cell.value === undefined) return prefix + '/>';
  if (typeof cell.value === 'number') {
    if (!Number.isFinite(cell.value)) throw new Error('Non-finite workbook value');
    return prefix + `><v>${cell.value}</v></c>`;
  }
  const text = String(cell.value).slice(0, 32000);
  // Literal inline strings, even for values beginning =, +, -, @, or tabs.
  return prefix + ` t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}
function sheetXml(sheet) {
  const rows = sheet.rows.map(row => `<row r="${row.index}" ht="${row.height ?? 22}" customHeight="1">${row.cells.sort((a,b) => a.column - b.column).map(cell => cellXml(cell, row.index)).join('')}</row>`).join('');
  const columns = sheet.columns.map((width, index) => `<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('');
  const freeze = sheet.freezeRows ?? 5;
  const lastColumn = columnName(sheet.columns.length);
  const lastRow = Math.max(...sheet.rows.map(row => row.index));
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : '';
  const bars = (sheet.bars || []).map((bar,index) => `<conditionalFormatting sqref="${bar.range}"><cfRule type="dataBar" priority="${index+1}"><dataBar showValue="1"><cfvo type="min"/><cfvo type="max"/><color rgb="FF${bar.color}"/></dataBar></cfRule></conditionalFormatting>`).join('');
  const hyperlinks = sheet.hyperlinks?.length ? `<hyperlinks>${sheet.hyperlinks.map(link => `<hyperlink ref="${link.ref}" location="${xml(link.location)}" display="${xml(link.display)}"/>`).join('')}</hyperlinks>` : '';
  return DECL + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView showGridLines="0" zoomScale="90" workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze+1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freeze+1}" sqref="A${freeze+1}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols>${columns}</cols><sheetData>${rows}</sheetData>${sheet.filter ? `<autoFilter ref="${sheet.filter}"/>` : ''}${merges}${bars}${hyperlinks}<pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="${sheet.name === 'Overview' ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="${sheet.name === 'Overview' ? 1 : 0}"/><headerFooter><oddFooter>&amp;LAPI Performance Report&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>${sheet.chart ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}
function relationship(id, type, target) { return `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`; }
function relationshipFile(body) { return DECL + `<Relationships xmlns="${PACKAGE_REL}">${body}</Relationships>`; }

function chartXml({ title, categories, values, sourceColumn, color, axisTitle, integer = false }) {
  const end = Math.max(6, categories.length + 5);
  const categoriesXml = categories.map((value, index) => `<c:pt idx="${index}"><c:v>${xml(value)}</c:v></c:pt>`).join('');
  const valuesXml = values.flatMap((value,index) => typeof value === 'number' && Number.isFinite(value) ? [`<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`] : []).join('');
  const richText = text => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="102A43"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US"/><a:t>${xml(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
  return DECL + `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart><c:title>${richText(title)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xml(title)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:cat><c:strRef><c:f>'Endpoints'!$A$6:$A$${end}</c:f><c:strCache><c:ptCount val="${categories.length}"/>${categoriesXml}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>'Endpoints'!$${sourceColumn}$6:$${sourceColumn}$${end}</c:f><c:numCache><c:formatCode>${integer ? '0' : '0.00'}</c:formatCode><c:ptCount val="${values.length}"/>${valuesXml}</c:numCache></c:numRef></c:val></c:ser><c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:gapWidth val="70"/><c:axId val="10001"/><c:axId val="10002"/></c:barChart><c:catAx><c:axId val="10001"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="10002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorGridlines/><c:title>${richText(axisTitle)}<c:overlay val="0"/></c:title><c:numFmt formatCode="${integer ? '0' : '0.00'}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}
function drawingsXml() {
  const anchor = (index, column) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>24</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${column+6}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>39</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index+1}" name="Performance chart ${index}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rId${index}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  return DECL + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchor(1,0)}${anchor(2,6)}</xdr:wsDr>`;
}
export function packWorkbook(sheets, charts) {
  const entries = {};
  const override = (name, type) => `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
  const sheetOverrides = sheets.map((_, index) => override(`xl/worksheets/sheet${index+1}.xml`, 'spreadsheetml.worksheet')).join('');
  entries['[Content_Types].xml'] = DECL + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override('xl/workbook.xml','spreadsheetml.sheet.main')}${override('xl/styles.xml','spreadsheetml.styles')}${sheetOverrides}${override('xl/drawings/drawing1.xml','drawing')}${override('xl/charts/chart1.xml','drawingml.chart')}${override('xl/charts/chart2.xml','drawingml.chart')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${override('docProps/app.xml','extended-properties')}</Types>`;
  entries['_rels/.rels'] = relationshipFile(relationship('rId1', 'officeDocument', 'xl/workbook.xml') + `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` + relationship('rId3', 'extended-properties', 'docProps/app.xml'));
  entries['xl/workbook.xml'] = DECL + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sheet,index) => `<sheet name="${xml(sheet.name)}" sheetId="${index+1}" r:id="rId${index+1}"/>`).join('')}</sheets><definedNames>${sheets.map((sheet,index) => `<definedName name="_xlnm.Print_Area" localSheetId="${index}">'${xml(sheet.name)}'!${sheet.printArea}</definedName>`).join('')}</definedNames><calcPr calcId="191029" fullCalcOnLoad="0"/></workbook>`;
  entries['xl/_rels/workbook.xml.rels'] = relationshipFile(sheets.map((_,index) => relationship('rId'+(index+1), 'worksheet', `worksheets/sheet${index+1}.xml`)).join('') + relationship('rId'+(sheets.length+1), 'styles', 'styles.xml'));
  entries['xl/styles.xml'] = stylesXml();
  sheets.forEach((sheet,index) => { entries[`xl/worksheets/sheet${index+1}.xml`] = sheetXml(sheet); });
  entries['xl/worksheets/_rels/sheet1.xml.rels'] = relationshipFile(relationship('rId1', 'drawing', '../drawings/drawing1.xml'));
  entries['xl/drawings/drawing1.xml'] = drawingsXml();
  entries['xl/drawings/_rels/drawing1.xml.rels'] = relationshipFile(relationship('rId1','chart','../charts/chart1.xml') + relationship('rId2','chart','../charts/chart2.xml'));
  entries['xl/charts/chart1.xml'] = chartXml(charts[0]);
  entries['xl/charts/chart2.xml'] = chartXml(charts[1]);
  const generatedAt = new Date().toISOString();
  entries['docProps/core.xml'] = DECL + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>API Performance Report</dc:title><dc:creator>API Performance Testing</dc:creator><cp:lastModifiedBy>API Performance Testing</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:modified></cp:coreProperties>`;
  entries['docProps/app.xml'] = DECL + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>API Performance Testing</Application><AppVersion>1.0</AppVersion></Properties>';
  return zipEntries(entries);
}
