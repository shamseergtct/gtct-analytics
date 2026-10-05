function printViaHiddenIframe(html) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute(
    "style",
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden"
  );
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
  const runPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      // ignore
    }
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        // ignore
      }
    }, 120_000);
  };
  iframe.onload = () => window.setTimeout(runPrint, 50);
  window.setTimeout(runPrint, 800);
  return iframe;
}

/**
 * Open HTML in a new window for printing. Uses a blob URL so content loads
 * reliably in Chrome/Safari/Edge (empty-window + document.write often stays blank).
 * Falls back to a hidden iframe if the pop-up is blocked.
 */
export function openHtmlPrintWindow(html, options = {}) {
  const { width = 900, height = 800, autoPrint = true } = options;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const features = `width=${width},height=${height},scrollbars=yes`;
  const popup = window.open(url, "_blank", features);

  if (!popup) {
    URL.revokeObjectURL(url);
    return printViaHiddenIframe(html);
  }

  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, 60_000);

  if (autoPrint) {
    window.setTimeout(() => {
      try {
        if (!popup.closed) {
          popup.focus();
          popup.print();
        }
      } catch {
        // HTML includes onload print() as a backup.
      }
    }, 600);
  }

  return popup;
}
