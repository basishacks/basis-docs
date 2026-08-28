---
layout: home

hero:
  name: basis-auth
  text: The identity boundary for Basis applications
  tagline: A compact OpenID Connect provider with an Entra-style management portal. Delegates human login to Microsoft, issues tokens to your apps, and keeps every administrative action auditable.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: Management Portal
      link: /portal

features:
  - icon: 🛡️
    title: Hardened by default
      details: Fixed-window rate limits per IP, PKCE everywhere, sandboxed image serving, __Host- cookies, append-only audit tables enforced by the application.
  - icon: ⚡
    title: Fast on hot paths
    details: Single-query identity assembly, memoized client metadata, atomic refresh rotation, keyset pagination that never degrades.
  - icon: 🗂️
    title: Full admin surface
    details: Users, app registrations with rotating secrets, resource servers, sessions, consents, sign-in logs, and an immutable audit trail.
  - icon: 🔑
    title: Local accounts + MFA
    details: Provision accounts with show-once credentials, NIST-style password policy, TOTP with hashed recovery codes.
---
