# IncidentLens evaluation

Version 1; identity `1bcabdcde796e6dd81678a4051435db35d3f425fe0062e53e04c55834b08d017`. Updated 2026-11-12T11:19:51.621Z.

Accuracy requires a concluded report with the correct top cause class/component. Top-pair matching also includes inconclusive candidates. Correct inconclusive outcomes are separate. All planned case/mode slots remain in rates; absent or failed investigations receive zero accuracy credit.

| Mode | Cause accuracy | Correct inconclusive | Conclusion coverage | Grounding (macro) | Citation validity (macro) |
| --- | --- | --- | --- | --- | --- |
| multi-agent | 5/9 (55.6%) | 1/1 (100.0%) | 6/10 (60.0%) | 90.7% | 100.0% |
| single-agent | 8/9 (88.9%) | 0/1 (0.0%) | 8/10 (80.0%) | 71.3% | 100.0% |

| Case | Mode | Execution | Outcome | Investigation attempts (model/tool) | Judge |
| --- | --- | --- | --- | --- | --- |
| inc-001 | multi-agent | completed | inconclusive | 9/1 | completed |
| inc-001 | single-agent | completed | concluded | 3/2 | completed |
| inc-002 | multi-agent | completed | concluded | 13/4 | completed |
| inc-002 | single-agent | completed | concluded | 4/8 | completed |
| inc-003 | multi-agent | completed | concluded | 18/5 | completed |
| inc-003 | single-agent | completed | concluded | 3/3 | completed |
| inc-004 | multi-agent | completed | concluded | 13/5 | completed |
| inc-004 | single-agent | completed | concluded | 5/5 | completed |
| inc-005 | multi-agent | completed | concluded | 13/9 | completed |
| inc-005 | single-agent | completed | concluded | 4/4 | completed |
| inc-006 | multi-agent | completed | concluded | 9/2 | completed |
| inc-006 | single-agent | completed | concluded | 4/3 | completed |
| inc-007 | multi-agent | completed | inconclusive | 11/3 | completed |
| inc-007 | single-agent | completed | inconclusive | 10/5 | completed |
| inc-008 | multi-agent | completed | inconclusive | 11/4 | completed |
| inc-008 | single-agent | completed | concluded | 5/3 | completed |
| inc-009 | multi-agent | completed | concluded | 15/6 | completed |
| inc-009 | single-agent | completed | concluded | 5/2 | completed |
| inc-010 | multi-agent | completed | inconclusive | 17/6 | completed |
| inc-010 | single-agent | failed | inconclusive | 12/6 | completed |

Grounding uses sentences from observed facts, known-cause explanations and action rationales, with support required for every factual clause. Summary, confidence prose, assumptions, unknowns and proposed action text are excluded. Missing/unresolved citations, judge failures and missing results cannot earn support. No selected claims scores 0/1. Automated judgment is imperfect. See JSON for claim verdicts, coverage, citation counts, separate investigator/judge latency and reported token subtotals, failures, settings and raw artifact paths. Unknown usage stays null/incomplete. Between-run pauses are recorded outside individual latency.
