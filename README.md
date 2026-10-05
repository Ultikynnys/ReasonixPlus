<h1 align="center">Reasonix+</h1>

<p align="center">
  <a href="https://github.com/Ultikynnys/ReasonixPlus/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Ultikynnys/ReasonixPlus/release.yml?style=flat-square&label=release&labelColor=161b22&logo=githubactions&logoColor=white" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Ultikynnys/ReasonixPlus.svg?style=flat-square&color=8b949e&labelColor=161b22" alt="license"/></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&labelColor=161b22" alt="Node >= 22"/>
  <img src="https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&labelColor=161b22" alt="Platform: Windows"/>
</p>

<br/>

<h3 align="center">A multi-provider coding agent for Windows, engineered around prefix-cache stability.</h3>
<p align="center">Token costs stay low across long sessions, so it is a tool you can leave running.</p>

> [!NOTE]
> **This is a standalone project, and here is why I split it.** I used upstream
> [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix) for a while, but then they
> rewrote it: they replaced the UI, ported everything to Go, and broke a lot of things for no real
> reason, so it got worse instead of better. I stayed on **v0.53** (the version that was stable, that
> I actually liked, and that had a lot of promise) and just kept iterating on it. About **2,000
> commits** later it was clearly better than what was there before, so I split the fork off into its
> own repository.
>
> The old repo also carried a lot of bloat I did not want to maintain: scaffolding to keep it working
> on Linux, macOS, and Windows for every kind of user, a pile of half-finished features, and
> localization that nobody actually needs, since people write code in English rather than their
> native language. I stripped all of it out, because it only made adding or fixing anything
> unnecessarily hard. What is left is a stripped-down Reasonix: the cross-platform and CLI surface is
> gone, the only product is the **Tauri 2 Windows app** backed by a headless JSON-RPC daemon, it is
> **multi-provider** now (DeepSeek, OpenAI, Ollama, Z.AI, Gemini) rather than DeepSeek-native, and the
> cache-first loop from the v0.53 line is carried forward. It is maintained here only and is never
> going back upstream, so treat the two codebases as unrelated.


