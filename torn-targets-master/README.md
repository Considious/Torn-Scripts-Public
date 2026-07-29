# Torn Target Master List

This small compiler combines:

- the existing compiled CSV (Baldr + Slinkies + any previously collected data),
- all 13 NetGangster legacy lists embedded in the public target page, and
- the copied “Just Another Hitlist” forum table.

The compiler does **not** need or store a Torn API key.

## Run

```powershell
node compile_targets.mjs `
  --compiled torn_leveling_targets_compiled_v2.csv `
  --forum forum-targets.txt `
  --output torn_leveling_targets_master.csv
```

The script needs Node.js 20+ and has no third-party package dependencies.

## Merge rules

- Torn player ID is the primary deduplication key.
- Case-insensitive username is the fallback when the forum source has no ID.
- The highest reported level is retained because Torn levels do not decrease.
- The highest reported battle-stat estimate is selected as the conservative
  value.
- `alternate_estimates`, `estimate_details`, and the conflict flag preserve
  disagreements instead of silently discarding them.
- Component stats are emitted only when they correspond to the selected total.
- Forum-only rows retain a username-based Torn profile lookup URL. Their player
  ID and attack URL remain blank until an ID is resolved.

## Sources

- https://github.com/OranWeb/tc-baldrs-levelling-list/blob/master/data.json
- https://docs.google.com/spreadsheets/d/1rFHSPkemKPieolxeps8Wvwxd28P9zqTN3kkD75-RDqw/edit
- https://www.torn.com/forums.php#/p=threads&f=61&t=16280317&b=0&a=0
- https://torn.netgangster.com/Targets.html

Keep API keys in environment variables if API enrichment is added later. Never
commit a key to the repository.
