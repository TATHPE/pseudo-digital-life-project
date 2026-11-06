# 开发时读过的论文

> 这张表是我们做记忆系统时真正读过的论文（24 篇），以及它们各自影响了哪个设计决定。
> **不随仓库分发 PDF**：arXiv 的授权不包含再分发，且 24 篇共 38 MB。点编号去 arXiv 取原文即可。

读法建议：先看下面两份中文导读（我们自己写的，带「结论有多可信」的判断），再回原文抠公式。

- [`论文中文导读.md`](论文中文导读.md) —— 记忆/遗忘这一批
- [`论文中文导读（二）记忆真实性.md`](论文中文导读（二）记忆真实性.md) —— 记忆污染/来源这一批

## 清单

| arXiv | 标题 |
|---|---|
| [2406.04175](https://arxiv.org/abs/2406.04175) | Confabulation The Surprising Value of Large Language |
| [2408.04681](https://arxiv.org/abs/2408.04681) | Conversational AI Powered by Large Language Models A |
| [2601.05504](https://arxiv.org/abs/2601.05504) | Memory Poisoning Attack and Defense on Memory Based |
| [2604.11563](https://arxiv.org/abs/2604.11563) | Synthius Mem Brain Inspired Hallucination Resistant |
| [2605.25869](https://arxiv.org/abs/2605.25869) | Mitigating Provenance Role Collapse in Long Term Age |
| [2606.17328](https://arxiv.org/abs/2606.17328) | MemTrace Probing What Final Accuracy Misses in Long |
| [2606.25161](https://arxiv.org/abs/2606.25161) | TRUSTMEM Learning Trustworthy Memory Consolidation f |
| [2607.15657](https://arxiv.org/abs/2607.15657) | Do Agents Dream of False Memories Black box Visual A |
| [2607.29167](https://arxiv.org/abs/2607.29167) | Memory Provenance Laundering in LLM Agents A Non Amp |
| [2608.13921](https://arxiv.org/abs/2608.13921) | When Personal Memory Has No Single Answer Evaluating |
| [2608.29606](https://arxiv.org/abs/2608.29606) | Agent Zero Memory Provenance Aware Long Term Memory |
| [2609.39473](https://arxiv.org/abs/2609.39473) | Beyond the Shadows of Plato s Cave Evaluating False |
| [2610.10265](https://arxiv.org/abs/2610.10265) | Stale Misattributed or Late Where Personal Memory Fa |
| [2610.12360](https://arxiv.org/abs/2610.12360) | Accurate but Not Humble Evaluating Epistemic Humilit |
| [2610.31446](https://arxiv.org/abs/2610.31446) | When Is a Memory Safe Enough to Act On Action Condit |
| — | DISCERN Preserve at Write Resolve at Read |
| — | Engram Synapses synaptic framework Frontiers |
| [2604.20300](https://arxiv.org/abs/2604.20300) | FSFM 2604.20300 |
| [2601.18642](https://arxiv.org/abs/2601.18642) | FadeMem 2601.18642 |
| [2604.00131](https://arxiv.org/abs/2604.00131) | Oblivion 2604.00131 |
| [2605.16045](https://arxiv.org/abs/2605.16045) | RecMem 2605.16045 |
| — | Sleep contribution to memory formation PhysiolRev |
| [2604.07894](https://arxiv.org/abs/2604.07894) | TSUBASA 2604.07894 |
| [2604.23878](https://arxiv.org/abs/2604.23878) | ZenBrain 2604.23878 |

## 这些论文改变了什么

| 论文主题 | 落到哪 |
|---|---|
| 遗忘曲线 / 衰减（FadeMem、FSFM、Oblivion） | `src/decay.ts` 的拉伸指数 + 四段生命周期 + 双阈值滞后 |
| 记忆整合与冲突（TRUSTMEM、MemTrace） | 夜间整理的「顶替/归并」与游标增量 |
| 幻觉与拒答（Confabulation、Epistemic Humility） | 三条拒答门 + 简报里「不确定就说不确定」 |
| 记忆污染与来源（Memory Poisoning、Provenance Laundering、Agent-Zero） | 每条记忆挂 `derived_from` / 原话引用；契约层不参与衰减 |
| 长期对话评测（LoCoMo 一类） | `docs/24-基准与口径.md`：我们的数字能跟谁比、不能跟谁比 |

> 口径提醒：这些系统的目标是「下一轮任务更准、更省 token」，没有一个把「人格连续性」当约束。
> 所以它们的数字只能看趋势，不能当本项目的验收标准。
