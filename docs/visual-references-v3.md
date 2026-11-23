# Visual references v3 — sources, algorithms, reuse boundaries

Research date: 2026-11-23 (Asia/Shanghai). Scope: research only; no third-party source, assets, fonts, audio, or visual compositions copied into application files. Exact repositories were inspected through raw GitHub HTTPS; a shallow-clone attempt under the ignored reference directory stalled and was cancelled.

## 1. Licensing comes before appearance

| Exact source / inspected revision | Evidence | Project decision |
| --- | --- | --- |
| [DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors/tree/eef4b5e38dcfe30064d5272d8ce5ee738d855f80) | [README: Credit + License](https://github.com/DhvanilPatel/swarm-cursors/blob/eef4b5e38dcfe30064d5272d8ce5ee738d855f80/README.md) says “None yet”; large engine portions adapted from Joel Califa’s unlicensed original Swarm; it credits the cursor set, flocking, choreography, rulers and overall look to him. | Public source is NOT a reuse grant. No engine, cursor artwork, visual sequence or assets copied. Generic task scheduling/measurement concepts only. |
| [cxyax/swarm-cursors-skills](https://github.com/cxyax/swarm-cursors-skills/tree/f8ab221244c15273277289b8ae546e0a70313f79) | [LICENSE](https://github.com/cxyax/swarm-cursors-skills/blob/f8ab221244c15273277289b8ae546e0a70313f79/LICENSE): MIT, copyright 2026 程序员阿鑫. [README](https://github.com/cxyax/swarm-cursors-skills/blob/f8ab221244c15273277289b8ae546e0a70313f79/README.md) explicitly names the first project as inspiration. | MIT requires notice retention for copied/substantial portions, but is not assurance of upstream provenance. To avoid ambiguity, do not copy its template/engine either. |
| [Ryder191/haloflux](https://github.com/Ryder191/haloflux/tree/46c8a0a5ccc11e8d815508696d282474fbd70fb2) | [LICENSE](https://github.com/Ryder191/haloflux/blob/46c8a0a5ccc11e8d815508696d282474fbd70fb2/LICENSE) and [README](https://github.com/Ryder191/haloflux/blob/46c8a0a5ccc11e8d815508696d282474fbd70fb2/README.md): PolyForm Noncommercial 1.0.0 plus express notices; no commercial licenses offered. | No code, assets, output, screenshots, design tracing or close visual reconstruction. Not an open-source commercial dependency. |

HALOFLUX expressly claims its audiovisual design: composition, motion/beat timing, layered light beams, ring/data-panel graphics, color treatment, layout and overall look and feel. The stated ban includes company/internal use, client/paid work, commercial products/services, advertising and selling derivatives/outputs. Noncommercial redistributions/remixes must retain required notices and attribution/link. Its screenshot/video/social-post rules require source attribution in the visible caption/title/description, not just a comment. The repository says pre-2026-10-26 history was MIT; that is not permission to use current versions, and no historical-version workaround is used here. Music has a separate stated CC0 credit, but is unnecessary and is not imported. These are observed upstream terms, not legal advice.

**Safe direction:** independently authored blue/silver flowing ribbon or folded signal surface; no radial sci-fi console, panel ring, five-layer beam system, shot sequence, copied names, sampled timing, or HALOFLUX palette/layout reproduction. Attribution alone would not cure prohibited commercial reuse.

## 2. Algorithm findings (descriptive, not implementation material)

### Swarm Rebuild: arbitrary DOM → temporary reconstruction

[Engine inspection](https://github.com/DhvanilPatel/swarm-cursors/blob/eef4b5e38dcfe30064d5272d8ce5ee738d855f80/swarm-rebuild/swarm.js) confirms DOM walking, separate renderer/view and scheduler. Its README describes:

- Snapshot live DOM/open shadow roots into boxes, styled text, lines, media, repeated-sibling groups and alignment guides. Screenshot-only media is subject to browser capture permissions.
- Render a blank isolated overlay, not the actual interactive page. Children wait on parent construction; duplicate work waits on a master; scrolling advances the available task frontier.
- Worker generators perform visible drawing/typing/guide operations; flocking is used around entry/completion. Return to the real page restores actual interactivity.
- This is a visual approximation, not a faithful DOM clone: animation freezing, pseudo-element limits, offscreen media placeholders; README caps approximately 4,000 layers / 40,000px.

**Implication:** a product intro should not implement an expensive all-page snapshot. Measure a few existing semantic targets; keep original live markup and preserve its semantics. Do not show rebuilding simulation as backend progress.

### Swarm Cursors Skills: explicit editable scene, not snapshotting

[SwarmEngine](https://github.com/cxyax/swarm-cursors-skills/blob/f8ab221244c15273277289b8ae546e0a70313f79/src/swarm/animation/SwarmEngine.js) maintains element/task indexes, dependency state, viewport conversion, a scroll frontier and worker generators. Its frame step clamps resumed-frame delta; task availability combines waiting state, viewport/frontier and completed dependencies. Assignment removes a task from the candidate list immediately to prevent double ownership. Visible-zone tasks outrank distance; worker population responds to scroll speed/backlog. Flight and rendering state are separated. [Motion helpers](https://github.com/cxyax/swarm-cursors-skills/blob/f8ab221244c15273277289b8ae546e0a70313f79/src/swarm/animation/motion.js) use ordinary easing and dirty-version tracking.

README integration constraints matter: explicit scene authoring; document scrolling; one instance; offset/transformed ancestors, nested scrollers and sidebars need adaptation. Demo and skill template are separate snapshots. No runtime AI API is required. Do not transplant its coordinate assumptions into this app.

### HALOFLUX: layered Canvas compositing

[Desktop engine](https://github.com/Ryder191/haloflux/blob/46c8a0a5ccc11e8d815508696d282474fbd70fb2/lab.html) inspection: native Canvas 2D, capped device-pixel ratio, offscreen surfaces for expensive visual layers, cached panel/sprite rendering, additive light compositing, separate update/draw phases and camera transforms. README describes an uneven beat clock, twelve pre-rendered micro-panel kinds, five outer beam layers and seven camera shots. These specifics define the restricted expression, not a recipe to reproduce.

**Generic performance lessons only:** cache expensive static geometry, isolate glow at lower resolution, cap DPR, limit animated object count, release all RAF/listeners, pause on hidden tabs. None requires HALOFLUX code or appearance.

## 3. Original intro proposal — LTZY signal assembly

This section is an original design proposal, not a source claim or port:

1. Measure a small bounded set of visible semantic targets after fonts/layout settle. Use viewport rectangles, remeasure on resize/scroll; do not serialize the page.
2. Give a few agents distinct roles (layout/type/path/material). Represent tasks as pending → active → done with explicit parent dependencies. Deterministic timing makes replay and screenshots reproducible.
3. Establish a short shared entrance, then assign measured work: align a baseline, trace a section perimeter, expose a heading, finish a material sweep. Keep actual labels readable; never fake typing into inputs or handling real requests.
4. Draw an original nonradial refractive ribbon as a separate decorative layer; its light follows the assembly phase rather than copied beats/music/camera shots.
5. Finish within a bounded intro, remove overlay and restore any modified styles/inert state. Escape/Skip must work immediately. Reduced-motion skips to usable content; route changes use only short staggered reveals.
6. Use one animation clock, frame-delta limits, DPR cap and hidden-tab pause. Cleanup must cancel RAF/timers, disconnect observers, remove listeners and restore focus/DOM state. Never require completion to access the app indefinitely.

## 4. Apple Liquid Glass: hierarchy, not blur everywhere

Primary sources: [Apple announcement, June 2025](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/) and [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials). Apple describes reflective/refractive translucent material, adapting to surrounding content/light/dark, with dynamic highlights; the HIG defines material as depth, layering and hierarchy between foreground/background. The HIG URL was fetched, but its full body is JavaScript-rendered; the directly verified statement there is its metadata definition.

Apply as original web craft: floating navigation/control layer over calmer content; a restrained silver edge highlight, soft directional shadow and background blur only where meaningful. Dense logs, code, tables and long copy need sufficiently opaque backgrounds. Avoid stacking glass-on-glass until contrast disappears. Provide solid-color fallback, visible focus, contrast checks, reduced motion and touch-sized targets. Apple material language is a reference, not copied Apple UI/assets or a claim of a native Liquid Glass implementation.

## 5. Anti-template / editorial craft

Search and full-page inspection: [Tom Molnar / Fit Design, Beyond the AI template](https://www.fitdesignldn.com/post/distinctive-website-design-beyond-ai-templates). It argues for business-owned subject matter, purposeful texture/typography and recognisability rather than novelty cursor effects alone. This is editorial judgment, not evidence that a particular style improves conversion. Also consulted local **Unslop**, by Damir Sokolovsky (@heydamir), CC BY 4.0; these notes summarize its quiet-chrome/product-native-richness principle rather than copying its text.

Project-specific synthesis:

- Put the richest light/material treatment in one original signal object and meaningful request/receipt visuals; let navigation and forms remain calm. User-requested glass/blue is compatible with this if it is intentional rather than applied to every rectangle.
- Compose different pages for different jobs: visual introduction, searchable model inventory, executable documentation, operational status. Avoid repeating hero → identical three-card grid → testimonial → CTA.
- Establish editorial hierarchy with one clear headline, constrained line lengths, intentional whitespace and tabular figures; vary section density instead of varying effects arbitrarily.
- Show actual model/status/usage data or plainly labeled examples. No fabricated clients, traffic, history or decorative numbers pretending to be telemetry.
- Motion should explain arrival, relation or state change. Scroll reveals cannot hide content permanently if JavaScript fails or reduced motion is enabled.

## Evidence / completion

Exact README + license status and engine architecture reviewed for all three requested repositories. Urgent licensing findings sent to lead and motion author before implementation integration; material/craft guidance sent to public and console authors. Only this research document is a tracked deliverable; reference download artifacts, if any, remain outside application source.
