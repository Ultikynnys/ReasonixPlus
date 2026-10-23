// Mutes and stops page media before it can play. Passed to the Playwright MCP server as
// --init-script, so a browsed page can never make noise out of the tool.
(() => {
  const silence = (el) => {
    try {
      el.muted = true;
      el.volume = 0;
    } catch (e) {}
    try {
      if (!el.paused) el.pause();
    } catch (e) {}
  };
  const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (proto && typeof proto.play === "function") {
    const play = proto.play;
    proto.play = function () {
      silence(this);
      return play.apply(this, arguments);
    };
  }
  const sweep = () => {
    for (const el of document.querySelectorAll("video,audio")) silence(el);
  };
  for (const type of ["play", "playing", "canplay", "loadeddata"]) {
    document.addEventListener(
      type,
      (e) => {
        const el = e.target;
        if (el && el.tagName && /^(VIDEO|AUDIO)$/i.test(el.tagName)) silence(el);
      },
      true,
    );
  }
  const root = document.documentElement;
  if (root) new MutationObserver(sweep).observe(root, { childList: true, subtree: true });
})();
