# Working in this repository

## The designer's decisions are final

The dashboard's RUNS tab has a **NOT A PROBLEM** button on every finding
and every suggestion. What the designer marks there lands in the Supabase
table `accepted_findings` (key, title, note, decided_at). Before calling
anything in a run a problem, before proposing a prompt change, and before
"fixing" a behaviour in the test conditions, read that list and leave those
behaviours alone — they have been ruled on, whatever a failing rationale
says. Read it with the public anon key:

    curl -s "https://lgyycoxsqrnhawzlqxlq.supabase.co/rest/v1/accepted_findings?select=key,title,note&order=decided_at.desc" \
      -H "apikey: sb_publishable_UhActVk58ukgC6On1z9yuw_IbsMeWJf"

Ruled on so far, before the table existed:

- Otto's first message, "Hello! How can I help you today?", is the
  platform's greeting, spoken before his first turn. It is correct by
  design; it is not one of his follow-up questions (at most three)
  (`elevenlabs/generate-tests.mjs`, the LENGTH condition, says so).

## The prompt is confidential, the repository is public

Otto's system prompt lives only in ElevenLabs. Never print it, diff it or
quote it — not in a job summary, a log, an artifact, a commit, a README,
the shared database or a chat reply. `agent_configs/` is gitignored and
stays so. The ElevenLabs API key lives only in the GitHub secret
`ELEVENLABS_API_KEY`; the agent id is public.

## How the designer works

No terminal: everything runs from the GitHub Actions buttons
(`.github/workflows/agent-suite.yml`) and the dashboard. Reports and
messages are read by a non-programmer — plain words, one idea per
sentence, examples over abstractions.
