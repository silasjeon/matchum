# Security policy

matchum is intentionally powerful: trusted local JavaScript can use Node APIs and act through
the user's signed-in Chrome profile. Please read the security model in `README.md` before
installing it.

## Supported versions

Before 1.0, only the latest release and the current `main` branch receive security fixes. No
backports are promised.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow for this repository. Do not include
exploit details, tokens, browsing data, or affected URLs in a public issue. If private reporting
is temporarily unavailable, open a public issue asking the maintainer to establish a private
contact channel, without describing the vulnerability.

Useful reports include the affected revision, platform and Chrome version, expected trust
boundary, minimal reproduction, and likely impact. Test with a disposable Chrome profile and
synthetic data.

## Security boundary

Security issues include, for example:

- a web page reaching the native daemon or CLI without trusted local configuration;
- another local user reaching the private CLI socket;
- origin or extension-ID validation being bypassed;
- page-controlled data unexpectedly becoming executable in an extension context;
- a default installation transmitting or persistently recording browsing data without opt-in;
- installer behavior that overwrites unrelated user files.

The following are intentional capabilities, not vulnerabilities by themselves:

- config and recipes execute with the current user's full Node privileges;
- `matchum-ctl eval` executes arbitrary code for the current local user;
- configured actions can inspect, modify, submit, purchase, or delete through signed-in pages;
- `world: "main"` scripts share the page's JavaScript context;
- an agent can be influenced by untrusted text it reads from a page.

No matchum core component sends telemetry to an external service. `page.activity` is local and
is enabled only when the config explicitly registers a handler for it.
