---
name: xerraire
description: Autonomous chat agent that dispatches tasks, searches documents, and manages workspaces via DeepSeek + Firebase
---

# Xerraire Agent

Xerraire is the conversational front-end agent for MakeYourCrew. It uses DeepSeek to understand user requests and execute tools across the platform.

## Agent files

- `server.js` — Express server with DeepSeek integration and tool execution
- `package.json` — Dependencies (express, pg, firebase-admin)

## Capabilities

- Chat with users in Catalan, Spanish, or English
- Detect task requests and dispatch them to agent crews
- Search project documents via Llull
- Create notes, scheduled tasks, and human actions in Firestore
- Search the agent marketplace
- Manage workspace settings
