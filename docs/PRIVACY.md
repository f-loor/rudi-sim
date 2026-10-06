# Rudi-Sim Privacy Policy

Effective date: October 6, 2026

Rudiverse LLC publishes Rudi-Sim, a free, open-source tool for checking websites in WebKit, taking screenshots, and recording walkthroughs. This policy covers the publisher's Rudi-Sim distribution and support. It does not replace the policies of GitHub, your AI assistant, your execution host, or websites you visit.

## Where processing happens

Rudi-Sim runs in the environment where you install or invoke it. With the desktop app or local Claude, that is your computer. With the OpenAI skills package in a cloud environment, it is that environment. A local desktop connection to ChatGPT uses a separately configured tunnel. Cloud execution is not processing solely on your laptop.

The distributed software does not include a Rudiverse-operated account service, advertising tracker, analytics collector, or upload service for your browsing sessions. Rudiverse LLC does not automatically receive your screenshots, recordings, browsing content, or tunnel credentials through such a service. This statement describes this distribution, not modified versions or every service used alongside it.

## Information the tool processes

To perform a requested check or walkthrough, Rudi-Sim processes website addresses, page content, visible controls, actions and entered values, browser session state, screenshots, recordings, and diagnostic information such as page errors. It also uses device presets, settings, project configurations, trusted-project records, and process/session information.

Screenshots and recordings can capture private information visible on a page. URLs, titles, page controls, screenshots, and diagnostic results can be returned to your assistant. A recording can include captions or information you type. Use sample data and test accounts; do not enter passwords, payment details, medical information, or other sensitive content into a recorded flow unnecessarily. Review outputs before sharing them.

## Storage and retention

The tool writes screenshots, videos, reports, session metadata, settings, and runtime state to the execution environment's filesystem. Desktop recordings remain there until you delete or move them; uninstalling the app may leave data behind. Cloud output retention depends on the host and any file-saving feature you use. Browser state may remain available during a session. Stopping a session does not delete its saved outputs.

The desktop credential feature uses the operating system's credential store for a configured tunnel key rather than its settings file. Command-line integrations and third-party tunnel software may handle credentials differently. Disconnecting a tunnel does not necessarily delete its stored key or revoke it at the provider.

## Connections and third parties

- Requested websites receive browser requests and may set cookies or otherwise process information under their own policies.
- Your connected AI provider can receive tool results, screenshots, page text, and any files you share with it. Its terms, retention settings, and privacy policy govern its processing. Rudi-Sim does not override those settings or promise that providers will not retain or use data.
- An optional OpenAI tunnel carries the configured desktop connection and its authentication through OpenAI's tunnel services.
- Runtime installation downloads dependencies and browser components from their distributors. The desktop update check contacts GitHub for release information. Those services can receive ordinary connection information, such as an IP address.
- GitHub hosts this project's source and public support. Activity there is subject to GitHub's policies.

The reviewed distribution does not send browsing outputs to Rudiverse LLC for advertising, sale, or AI-model training. This does not describe the independent practices of the services above.

## Support information

If you voluntarily open an issue or otherwise contact maintainers through GitHub, Rudiverse LLC and project maintainers can receive the account name, message, and attachments you provide. They use that information to address support, privacy, or security concerns and maintain the project. Issues and comments are public unless GitHub explicitly marks the channel private. Do not post secrets, confidential URLs, or unredacted recordings.

Support records can remain in GitHub while needed to resolve an issue or document project history, subject to applicable obligations and GitHub's retention. For a deletion or privacy request, open a minimal issue identifying your GitHub account and the relevant record, without adding sensitive information. Maintainers can address information they control; requests concerning GitHub or your AI host may need to go to that provider. No fixed support response time is promised.

## Your controls and rights

Choose authorized websites and test data, stop sessions, disconnect integrations, delete saved files and stored credentials, and revoke tunnel credentials at their provider when appropriate. Review host retention settings and remove copies saved elsewhere. Do not assume deleting one copy deletes others.

Depending on applicable law, you may have rights to access, correct, delete, restrict, or object to processing of personal information held by the publisher, and to complain to a relevant supervisory authority. Request those rights through the support link below. Applicable legal rights are not limited by this policy. Third-party providers may process information in other countries under their own arrangements.

## Security and changes

No software or network connection can guarantee complete security. Keep the app, runtime, browser, and operating system updated and use the tool only with data you are authorized to process. This tool is not designed to provide compliance certification or safeguards for regulated sensitive data.

Updates to this policy will be posted here with a revised effective date. A new policy does not itself authorize a new use of previously collected information where notice or consent is required.

Support and privacy requests: [Rudi-Sim support](SUPPORT.md).

