# M10.7 Cheap-tier reliability repetition

Date: 2026-08-03

## Method

The existing fixed capability corpus ran ten fresh, independent iterations for Luna and then Terra. Each iteration covered the same three shapes: Low documentation, Medium library implementation, and High dependent CLI integration. Every attempt used explicit high reasoning effort, the normal confined adapter and resource ledger, the existing scope gate, a repository-authored deterministic validity check, and shadow tests. Runs were sequential and shadow-only; nothing adopted or promoted.

The one-off limits were 300,000 tokens per call and 4,000,000 tokens per corpus session. Global defaults were restored to 150,000 per call and 500,000 per session after each run.

Immutable reports:

- Luna: `.hivemind/resource/capability-corpus/CC-20260803235418-6c99ecfd-19c6-4f59-aaa3-3b2be17d7090/report.json`
- Terra: `.hivemind/resource/capability-corpus/CC-20260804002023-48cfcd1a-c558-4e08-8d19-fb5082fdf70a/report.json`
- Sol comparison baseline: `.hivemind/resource/capability-corpus/CC-20260803213757-d3a455e3-217a-4f78-b136-fde44190dc3d/report.json`

## Results

| Model | Shape | Pass rate | Revisions | Provider tokens | Cached input | Average wall time | Total cost | Cost per successful task |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna | Documentation | 10/10 | 0 | 996,005 | 823,040 / 985,441 (83.52%) | 31.08s | $0.03080890 | $0.00308089 |
| Luna | Library | 10/10 | 0 | 904,211 | 704,000 / 886,724 (79.39%) | 44.71s | $0.03580460 | $0.00358046 |
| Luna | Dependent CLI | 10/10 | 0 | 1,632,361 | 1,367,808 / 1,603,110 (85.32%) | 68.31s | $0.05475888 | $0.00547589 |
| Terra | Documentation | 10/10 | 0 | 906,100 | 765,184 / 898,387 (85.17%) | 25.74s | $0.63999850 | $0.06399985 |
| Terra | Library | 10/10 | 0 | 1,204,583 | 1,025,536 / 1,184,011 (86.62%) | 53.53s | $0.96115150 | $0.09611515 |
| Terra | Dependent CLI | 10/10 | 0 | 1,429,643 | 1,221,888 / 1,406,038 (86.90%) | 57.70s | $1.11992200 | $0.11199220 |

Luna passed 30/30 for $0.12137238, or $0.00404575 per successful task including every attempt. Terra passed 30/30 for $2.72107200, or $0.09070240 per successful task. No attempt failed, so there were no failure modes or observed retry costs. Combined actual spend was $2.84244438 across 60 paid calls.

## Retry economics

The matched live Sol baseline passed all three shapes at $0.13503600, $0.29067100, and $0.23783000 respectively, averaging $0.22117900 per successful task. Repeating that baseline mix ten times would cost $6.63537000.

The observed cheap-tier failure rate was zero, so the measured Luna-plus-Sol-retry cost remains $0.00404575 per successful task and the Terra-plus-Sol-retry cost remains $0.09070240. No actual fallback call was needed; fallback reliability remains conditional on the one-observation-per-shape Sol baseline.

Using those observed average costs, a hypothetical 30% Luna failure rate followed by one successful Sol retry would cost approximately $0.07039945 per completed task. Luna would remain cheaper than starting with Sol until approximately a 98.17% failure rate. Terra would remain cheaper until approximately a 58.99% failure rate. These are price break-even calculations, not observed reliability claims; latency and repeated retry failure are excluded.

## Interpretation

At high reasoning effort, both configured cheap tiers were reliable on this fixed corpus: every Low, Medium, and High-shaped attempt passed the independent disposer without revision. Luna's observed cost per success was about 54.7 times lower than Sol's baseline; Terra's was about 2.4 times lower. Ten successes per shape are materially stronger than the original single observation, but they do not establish general coding reliability outside these narrow fixtures. The results are Tier-1 evidence only and grant no routing authority without the existing human Tier-2 promotion gate.
