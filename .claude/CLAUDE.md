# Collaborator Workspace

This is a Collaborator workspace. Files in the root are sources (notes, articles, transcripts).
Files in `.collaborator/` are managed by the Collaborator agent.

## File types
- Sources (root): note, article, transcript, pdf
- Inferences (.collaborator/inferences/): concept, insight, objective

## Front-matter
All .md files should have YAML front-matter with at least a `type` field.
Files without `collab_reviewed: true` are inbox items awaiting processing.

## Persona
- `.collaborator/persona/identity.md` — who this collaborator is
- `.collaborator/persona/values.md` — beliefs, priorities, decision style

<!-- collaborator:rpc-start -->

## Collaborator RPC

The Collaborator desktop app exposes a JSON-RPC 2.0 server over a Unix domain socket.
Read the socket path from `/Users/admin/.collaborator/socket-path`, then send newline-delimited JSON.

Call `rpc.discover` to list available methods:
```bash
SOCK=$(cat "/Users/admin/.collaborator/socket-path")
echo '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}' | nc -U "$SOCK"
```

<!-- collaborator:rpc-end -->
