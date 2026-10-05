<h1 align="center">Reasonix+</h1>

<p align="center">
  <a href="https://github.com/Ultikynnys/ReasonixPlus/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Ultikynnys/ReasonixPlus/release.yml?style=flat-square&label=release&labelColor=161b22&logo=githubactions&logoColor=white" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Ultikynnys/ReasonixPlus.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&labelColor=161b22" alt="Node >= 22"/>
</p>

<br/>

<h3 align="center">A multi-provider coding agent for Windows, engineered around prefix-cache stability.</h3>
<p align="center">Token costs stay low across long sessions, so it is a tool you can leave running.</p>

> [!NOTE]
> **This is a standalone project.** It is based on v0.53 of
> [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix), but it has diverged enough to
> stand on its own: it is no longer a DeepSeek-native agent but a **multi-provider** one (DeepSeek,
> OpenAI, Ollama, Z.AI, and Gemini/Antigravity), the Ink TUI and the interactive CLI chat modes are
> gone, the only product surface is the Tauri 2 Windows app backed by a headless JSON-RPC daemon, and
> the cache-first loop from the v0.53 line was ported forward. It is maintained here only and is
> never intended to be pushed or merged back upstream; treat the two codebases as unrelated. The
> concrete differences are listed in [Divergence from upstream](#divergence-from-upstream).

> [!TIP]
> **Cache stability is not a feature you turn on; it is an invariant the loop is designed around.**
> DeepSeek bills cached input at a small fraction of the miss rate, and the cache only hits when the
> exact byte prefix of the previous request is preserved. Every layer of the loop is tuned to keep
> that prefix byte-stable. DeepSeek remains the default backend; OpenAI, Ollama, Z.AI, and Gemini
> are supported as options (see [Backends and models](#backends-and-models)).


