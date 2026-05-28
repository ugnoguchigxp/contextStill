---
layout: default
title: memoryRouter | Adaptive Knowledge Compiler
description: コーディングエージェント向けのエビデンス付き適応型ナレッジコンパイラ
permalink: /
image: /assets/img/og-image.jpg
body_class: lp-body
preload_hero: true
twitter_image_alt: 知識蒸留をテーマにした memoryRouter のキービジュアル
og_image_alt: 知識蒸留をテーマにした memoryRouter のキービジュアル
---

<main class="lp">
  <section class="hero">
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="{{ '/' | relative_url }}">memoryRouter</a>
        <div class="chip">local-first / evidence-backed</div>
      </header>

      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Evidence-backed Adaptive Knowledge Compiler</p>
          <h1>
            記憶ではなく、<br>
            <span>実行に効く知識</span>を<br>
            コンパイルする。
          </h1>
          <p class="lead">
            memoryRouter は、Wiki・Web・コミット・Codex/Antigravity ログから
            再利用可能な <span class="mono">rule / procedure</span> を蒸留し、
            タスクごとに context pack を最適化する知識基盤です。
          </p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="https://github.com/ugnoguchigxp/memoryRouter">GitHubで見る</a>
            <a class="btn btn-secondary" href="https://github.com/ugnoguchigxp/memoryRouter/blob/main/README.md">READMEを読む</a>
          </div>
          <div class="mini-metrics">
            <div><strong>Rule / Skill</strong><span>knowledge model</span></div>
            <div><strong>Pre-commit</strong><span>usefulness score</span></div>
            <div><strong>Post-commit</strong><span>candidate distillation</span></div>
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

  <section class="section">
    <div class="shell">
      <h2>What Makes It Different</h2>
      <div class="cards">
        <article class="card">
          <h3>Evidence & Provenance</h3>
          <p>すべての knowledge に根拠ソースを紐づけ、由来を追跡できます。</p>
        </article>
        <article class="card">
          <h3>Executable Skills</h3>
          <p>短い rule と実行可能な procedure を分離して、実行フローに直結させます。</p>
        </article>
        <article class="card">
          <h3>Utility Feedback</h3>
          <p>compile_eval を蓄積し、使われる知識・効く知識を継続的に更新します。</p>
        </article>
        <article class="card">
          <h3>Knowledge Landscape</h3>
          <p>偏り・密度・劣化を observability として運用対象にできます。</p>
        </article>
      </div>
    </div>
  </section>

  <section class="section section-flow">
    <div class="shell">
      <h2>How The Loop Works</h2>
      <div class="flow">
        <article class="flow-step"><span>01</span><p>sources から候補を抽出</p></article>
        <article class="flow-step"><span>02</span><p>distillation と重複抑制</p></article>
        <article class="flow-step"><span>03</span><p>task-aware context compile</p></article>
        <article class="flow-step"><span>04</span><p>pre-commit usefulness評価</p></article>
        <article class="flow-step"><span>05</span><p>post-commit candidate登録</p></article>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="shell">
      <h2>RAGとの違い</h2>
      <div class="compare">
        <article class="compare-box">
          <h3>Typical RAG</h3>
          <ul>
            <li>documents を chunk 化して検索</li>
            <li>検索結果を prompt に注入</li>
            <li>実行結果が知識品質へ戻りにくい</li>
          </ul>
        </article>
        <article class="compare-box active">
          <h3>memoryRouter</h3>
          <ul>
            <li>sources から rule/procedure を蒸留</li>
            <li>token budget 内で context pack をコンパイル</li>
            <li>feedback loop で knowledge を進化</li>
          </ul>
        </article>
      </div>
    </div>
  </section>

  <section class="cta">
    <div class="shell">
      <div class="cta-panel">
        <h2>From agent worklogs to reusable skills.</h2>
        <p>
          memoryRouter は、単なる memory ではなく、
          実行品質を上げるための adaptive knowledge compiler です。
        </p>
        <a class="btn btn-primary" href="https://github.com/ugnoguchigxp/memoryRouter">GitHub プロジェクトを見る</a>
      </div>
    </div>
  </section>
</main>

<footer class="footer">
  <div class="shell">memoryRouter LP · GitHub Pages + Jekyll</div>
</footer>
