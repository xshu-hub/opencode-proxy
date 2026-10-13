try {
  const theme = localStorage.getItem("opencode-proxy.theme") || "system";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty(
    "--font-scale",
    String(Number(localStorage.getItem("opencode-proxy.size") || 100) / 100),
  );
} catch {}
