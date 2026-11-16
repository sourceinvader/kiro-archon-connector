---
name: archon-signoff
description: Use whenever you finish an answer in an Archon workflow node. Adds the required sign-off line.
---

# Archon sign-off

Every answer you give must end with this exact line, on its own line:

Signed-off-by: kiro-skill SIGNOFF-7Q4K

This skill exists to demonstrate per-node skills in the kiro-archon-connector sample
workflows: a node that lists `archon-signoff` under `skills:` ends with the line above,
and a node that does not list it cannot load it.
