---
layout: default
title: contextStill | Local-first Memory Compiler
description: AI coding agent 向けの local-first memory compiler
permalink: /
image: /assets/img/og-image.jpg
body_class: lp-body
preload_hero: true
twitter_image_alt: 知識蒸留をテーマにした contextStill のキービジュアル
og_image_alt: 知識蒸留をテーマにした contextStill のキービジュアル
---

<main class="lp">
  <section class="hero">
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="{{ '/' | relative_url }}">contextStill</a>
        <div class="chip">local-first / evidence-backed</div>
      </header>

      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Local-first Memory Compiler for AI Coding Agents</p>
          <h1>
            記憶ではなく、<br>
            <span>実行に効く知識</span>を<br>
            コンパイルする。
          </h1>
          <p class="lead">
            contextStill は、AI coding agent のための local-first memory compiler です。
            作業ログ・docs・判断履歴を、次の実行に効く
            <span class="mono">rule / procedure / decision context</span> に変換します。
          </p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#three-minutes">3分で違いを見る</a>
            <a class="btn btn-secondary" href="https://github.com/ugnoguchigxp/contextStill">GitHubで見る</a>
          </div>
          <div class="mini-metrics">
            <div><strong>Before task</strong><span>compile focused context</span></div>
            <div><strong>At blocker</strong><span>decide with evidence</span></div>
            <div><strong>After task</strong><span>learn from feedback</span></div>
          </div>
        </div>

        <aside class="hero-stage">
          <figure class="hero-visual">
            <picture>
              <source
                srcset="{{ '/assets/img/knowledge-distillation-hero.webp' | relative_url }}"
                type="image/webp"
              >
              <img
                src="{{ '/assets/img/knowledge-distillation-hero.png' | relative_url }}"
                alt="Knowledge distillation concept illustration"
                width="1586"
                height="992"
                loading="eager"
                decoding="async"
                fetchpriority="high"
              >
            </picture>
          </figure>
          <div class="beam beam-a"></div>
          <div class="beam beam-b"></div>

          <article class="stage-card stage-left">
            <h3>Sources</h3>
            <ul>
              <li>Wiki / Docs</li>
              <li>Website URLs</li>
              <li>Commits</li>
              <li>Agent Logs</li>
            </ul>
          </article>

          <article class="stage-card stage-center">
            <h3>Compiler</h3>
            <ul>
              <li>Evidence check</li>
              <li>Task-aware compile</li>
              <li>Token budget control</li>
              <li>Lifecycle & decay</li>
            </ul>
          </article>

          <article class="stage-card stage-right accent">
            <h3>Context Pack</h3>
            <ul>
              <li>Rules</li>
              <li>Procedures</li>
              <li>Pitfalls</li>
              <li>References</li>
            </ul>
          </article>

          <article class="score-card">
            <p>Feedback</p>
            <strong>92 / 100</strong>
            <span>utility tracked by knowledge_id</span>
          </article>
        </aside>
      </div>
    </div>
  </section>

  <section class="section" id="three-minutes">
    <div class="shell">
      <div class="section-heading">
        <p class="eyebrow">Three-minute comparison</p>
        <h2>Chat history でも、普通のRAGでもない。</h2>
        <p>
          contextStill は documents を検索して終わりではありません。
          エージェントが次の作業で使える、短い rule、実行手順、判断根拠に変換します。
        </p>
      </div>

      <div class="compare compare-three">
        <article class="compare-box">
          <h3>Chat history</h3>
          <dl>
            <div><dt>Input</dt><dd>過去の会話と長いログ</dd></div>
            <div><dt>Output</dt><dd>その場の思い出し</dd></div>
            <div><dt>Feedback</dt><dd>次の作業に残りにくい</dd></div>
            <div><dt>Ops</dt><dd>品質を測りにくい</dd></div>
          </dl>
        </article>
        <article class="compare-box">
          <h3>Typical RAG</h3>
          <dl>
            <div><dt>Input</dt><dd>docs を chunk 化</dd></div>
            <div><dt>Output</dt><dd>関連文書の抜粋</dd></div>
            <div><dt>Feedback</dt><dd>実行結果が戻りにくい</dd></div>
            <div><dt>Ops</dt><dd>検索品質が中心</dd></div>
          </dl>
        </article>
        <article class="compare-box active">
          <h3>contextStill</h3>
          <dl>
            <div><dt>Input</dt><dd>docs、agent logs、candidate notes</dd></div>
            <div><dt>Output</dt><dd>rule / procedure / decision context</dd></div>
            <div><dt>Feedback</dt><dd>compile_eval と candidate 登録</dd></div>
            <div><dt>Ops</dt><dd>doctor、queue、knowledge lifecycle</dd></div>
          </dl>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-before-after">
    <div class="shell">
      <div class="section-heading">
        <p class="eyebrow">Before / After</p>
        <h2>エージェントの「忘れる」を、運用できる知識に変える。</h2>
      </div>

      <div class="before-after">
        <article class="state-panel before">
          <span>Before</span>
          <h3>毎回、同じ確認から始まる</h3>
          <ul>
            <li>過去の失敗やローカルルールが会話に埋もれる</li>
            <li>PR前の判断やユーザー嗜好を思い出せない</li>
            <li>長いログを貼っても、次回の品質改善に残らない</li>
          </ul>
        </article>
        <article class="state-panel after">
          <span>After</span>
          <h3>作業前に、必要な文脈だけが届く</h3>
          <ul>
            <li><span class="mono">context_compile</span> が task-specific context pack を返す</li>
            <li><span class="mono">context_decision</span> がブロッカー判断を根拠付きで支える</li>
            <li><span class="mono">compile_eval</span> と candidate 登録で次の作業に学びが戻る</li>
          </ul>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-flow">
    <div class="shell">
      <div class="section-heading">
        <p class="eyebrow">Static demo</p>
        <h2>3分デモ: 作業ログを、次の実行文脈へ。</h2>
      </div>

      <div class="demo-grid">
        <article class="demo-step">
          <span>01</span>
          <h3>Evidence を集める</h3>
          <p>Wiki、docs、agent logs、明示的な candidate note を local database に取り込みます。</p>
          <pre><code>bun run sync:agent-logs
bun run import:wiki ./wiki/pages</code></pre>
        </article>
        <article class="demo-step">
          <span>02</span>
          <h3>Task context をコンパイル</h3>
          <p>作業前に MCP から、必要な rule と procedure だけを短く受け取ります。</p>
          <pre><code>context_compile({
  goal: "fix queue health drift",
  domains: ["queue", "doctor"]
})</code></pre>
        </article>
        <article class="demo-step">
          <span>03</span>
          <h3>結果を学習ループに戻す</h3>
          <p>有用性を評価し、再利用できる学びを candidate として登録します。</p>
          <pre><code>compile_eval({
  outcome: "useful",
  relevance: 92
})</code></pre>
        </article>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="shell">
      <div class="section-heading">
        <p class="eyebrow">Why it stays useful</p>
        <h2>知識を、検索結果ではなく運用対象にする。</h2>
      </div>

      <div class="cards">
        <article class="card">
          <h3>Evidence & Provenance</h3>
          <p>すべての knowledge に根拠ソースを紐づけ、由来を追跡できます。</p>
        </article>
        <article class="card">
          <h3>Executable Procedures</h3>
          <p>短い rule と実行可能な procedure を分離して、作業フローに直結させます。</p>
        </article>
        <article class="card">
          <h3>Decision Feedback</h3>
          <p>ブロッカー判断と Good/Bad feedback を保存し、次の判断品質に戻します。</p>
        </article>
        <article class="card">
          <h3>Knowledge Operations</h3>
          <p>doctor、queue、lifecycle で、鮮度・偏り・劣化を確認できます。</p>
        </article>
      </div>
    </div>
  </section>

  <section class="cta">
    <div class="shell">
      <div class="cta-panel">
        <h2>From agent worklogs to reusable skills.</h2>
        <p>
          contextStill は、単なる memory ではなく、
          AI coding agent の実行品質を上げるための local-first memory compiler です。
        </p>
        <div class="hero-actions cta-actions">
          <a class="btn btn-primary" href="https://github.com/ugnoguchigxp/contextStill/blob/main/spec/pub/getting-started.md">最初の compile を試す</a>
          <a class="btn btn-secondary" href="https://github.com/ugnoguchigxp/contextStill">GitHub プロジェクトを見る</a>
        </div>
      </div>
    </div>
  </section>
</main>

<footer class="footer">
  <div class="shell">contextStill LP · GitHub Pages + Jekyll</div>
</footer>
