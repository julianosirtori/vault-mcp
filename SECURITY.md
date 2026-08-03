# Security policy

`vault-mcp` handles private notes and authentication credentials. Please do
not open a public issue for a suspected vulnerability.

## Supported versions

The project is currently a work in progress. Until the first stable release,
security fixes are made only on the latest commit of the `main` branch.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button on the repository's Security
tab to send a private report. Include:

- the affected component and commit;
- reproduction steps or a minimal proof of concept;
- the security impact you observed;
- any suggested remediation, if known.

Please avoid accessing data that is not yours, disrupting a deployed service,
or publishing exploit details before a fix is available. You should receive
an acknowledgement within seven days. Confirmed issues will be coordinated
privately through GitHub Security Advisories until a fix and disclosure plan
are ready.

## Deployment reports

Questions about configuring or operating your own instance are not security
reports unless they demonstrate a vulnerability. Use a normal GitHub issue
for those questions, without including vault content, tokens, secrets, tunnel
credentials, logs containing sensitive paths, or other private data.
