# Field report: <period, e.g. 2026-09-23 to 2026-10-23>

- **self-review:** <environment.pluginVersions from the signals>
- **Claude Code:** <environment.claudeCode>
- **Models:** main <environment.mainModels>; reviewers <as seen in the episode windows, or "not seen">
- **OS:** <environment.os>
- **Period:** <period.days> days since <period.since> (<period.basis>), <sessions> sessions on <activeDays> days
- **Missing:** <if period.missingBefore is a date: "transcripts before <date> no longer exist, so no window predates it"; otherwise delete this line>

## Signals

Printed by `retro.mjs signals`. Do not edit.

```text
<signals.txt, verbatim>
```

## What worked (keep these)

- **<behaviour>** — `plugin/<path>`. Evidence: <a signal line or "n of 8 episodes">.

## Weaknesses

### W1 · <one line, in plugin vocabulary>

- **Mechanism:** `plugin/<path>` <symbol, if one>
- **Class:** gate-misfire | gate-miss | stall | wasted-round | wasted-agent | cost | instruction-misread | polling | oscillation | tooling-error | other
- **Symptom:** <what the plugin did, in its own terms: the gate rule, the script output, the marker field>
- **Frequency:** <n of m episodes>, <the signal it shows up in, if any>
- **Measured cost:** <turns or tokens, or leave blank>
- **Severity:** safety | blocks-work | costs-tokens | papercut
- **Confidence:** measured | seen-once | suspected
- **Suggested fix:** <optional>

## In the reporter's words

1. **Did the gate stop you when there was nothing to review, or let something through it should have stopped?** <answer, or "skipped">
2. **Did you turn it off, or want to? When?** <answer, or "skipped">
3. **What would you keep no matter what?** <answer, or "skipped">
