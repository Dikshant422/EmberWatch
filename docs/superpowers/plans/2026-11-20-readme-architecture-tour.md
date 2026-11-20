# README Architecture and Project Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the README's stale status-oriented content with an accurate public overview, architecture diagram, feature tour, setup instructions, and limitations.

**Architecture:** This is a documentation-only change centered on `README.md`. The README must mirror the implemented Python pipeline, static dashboard, generated JSON artifacts, and external browser services found in the workspace.

**Tech Stack:** Markdown, Mermaid, Python, JavaScript, Leaflet, Chart.js

**Spec:** Approved in the conversation on 2026-11-20: one documentation-only README rewrite with a Mermaid architecture/data-flow diagram and a project tour.

## Global Constraints

- Say "fire detections", never "wildfires".
- Never state or imply a cause for detections.
- Call the metric a "short-term signal", not a trend.
- Call recommendations "suggested checks", not protocols.
- Clearly distinguish implemented features from stretch ideas.
- Do not publish raw FIRMS data or generated cache details as live claims.
- Keep setup commands accurate for a static dashboard served by Python.

## Review Focus

- Mislabeling the project or data sources: document NASA FIRMS VIIRS NOAA-20/NOAA-21 and Natural Earth boundaries.
- Presenting unvalidated priority weights as scientific truth: label the 0.5/0.2/0.3 score as a starting choice.
- Missing the proximity mode: document point-radius and route-corridor checks plus Nominatim/OSRM dependencies.
- Incorrect run or test instructions: verify commands against the repository files.
- Mermaid rendering: keep the diagram simple enough for GitHub and preserve exact file/data boundaries.
- Stale claims: remove completed-only status and treat report/pitch items as upcoming unless implemented.

---

### Task 1: Rewrite README

**Files:**
- Modify: `README.md`
- Reference: `index.html`, `app.js`, `proximity.js`, `build_data.py`, `data.py`, `join.py`, `requirements.txt`

- [ ] **Step 1:** Replace the README with sections for project overview, features, architecture diagram, project tour, quick start, data refresh, testing, configuration/rules, limitations, project structure, and contributors.
- [ ] **Step 2:** Add a Mermaid diagram showing FIRMS and Natural Earth inputs, Python loading/joining/scoring/build stages, committed JSON outputs, the browser frontend, and Leaflet/Chart.js.
- [ ] **Step 3:** Add a feature tour covering world/country/state selection, canvas 0.25-degree map, priority table/sorting, Chart.js series, summary/suggested checks, and point/corridor proximity screening.
- [ ] **Step 4:** Keep the existing setup and refresh commands, add Python test commands and a Node proximity-math command, and include external network dependencies.

### Task 2: Verify README accuracy

**Files:**
- Review: `README.md`
- Test: `test_data.py`, `test_join.py`, `test_decision.py`, `test_proximity_math.js`

- [ ] **Step 1:** Scan README terminology for prohibited terms and verify all file names/commands exist.
- [ ] **Step 2:** Run `python test_data.py`, `python test_join.py`, `python test_decision.py`, and `node test_proximity_math.js`.
- [ ] **Step 3:** Start `python -m http.server` briefly and verify the README's URL is responsive.
- [ ] **Step 4:** Review the final diff for documentation-only scope and no unrelated edits.
