import { useEffect, useMemo, useState } from "react";

export const DEFAULT_PAGE_SIZE = 25;
const EMPTY_ROWS = [];

/**
 * Client-side pagination for in-memory lists.
 * @param {unknown[]} items
 * @param {{ pageSize?: number, resetKey?: string | number }} [options]
 */
export function usePagination(items, { pageSize = DEFAULT_PAGE_SIZE, resetKey } = {}) {
  const rows = Array.isArray(items) ? items : EMPTY_ROWS;
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);

  const pageCount = Math.max(1, Math.ceil(rows.length / size));

  useEffect(() => {
    setPage(1);
  }, [resetKey, size, rows.length]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * size;

  const pageItems = useMemo(
    () => rows.slice(start, start + size),
    [rows, start, size]
  );

  const total = rows.length;
  const from = total === 0 ? 0 : start + 1;
  const to = Math.min(start + size, total);

  return {
    page: safePage,
    setPage,
    pageCount,
    pageItems,
    pageSize: size,
    total,
    from,
    to,
    hasPrev: safePage > 1,
    hasNext: safePage < pageCount,
    goPrev: () => setPage((p) => Math.max(1, p - 1)),
    goNext: () => setPage((p) => Math.min(pageCount, p + 1)),
  };
}
