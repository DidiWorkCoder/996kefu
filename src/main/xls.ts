import { readFileSync, statSync } from 'node:fs';
import * as XLSX from 'xlsx';

/**
 * 读取工作簿（老式 .xls / 新式 .xlsx 都支持）。
 *
 * 这里刻意不用 `XLSX.readFile`：打包后 xlsx 内部的 `_fs` 可能拿不到 node 的 fs，
 * 会退化到 ExtendScript 分支并抛出「Cannot access file xxx」这种毫无信息量的错误。
 * 自己读成 Buffer 再交给 `XLSX.read`，既能绕开该分支，出错时也能拿到真实的 errno（如文件不存在）。
 */
const readBook = (file: string) => XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false });

/** 列出所有工作表名 */
export function xlsSheets(file: string): string[] {
  return readBook(file).SheetNames;
}

/** 把单元格统一转成去除首尾空白的字符串 */
const cell = (v: unknown): string => String(v ?? '').trim();

/** 读取某个工作表的全部行（按行返回二维数组，空行保留） */
export function xlsRows(file: string, sheet: string, skipRows = 0): string[][] {
  const book = readBook(file);
  const ws = book.Sheets[sheet];
  if (!ws) throw new Error(`工作表不存在：${sheet}`);
  const all = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
  return all.slice(Math.max(0, skipRows)).map((r) => (Array.isArray(r) ? r.map(cell) : []));
}

/** 预览前若干行（表格选择器用） */
export function xlsPreview(p: { file: string; sheet: string; skipRows: number; limit?: number }): string[][] {
  const rows = xlsRows(p.file, p.sheet, p.skipRows);
  return rows.slice(0, Math.max(1, p.limit ?? 20));
}

/** 文件修改时间，用于缓存失效判断 */
export function xlsMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
