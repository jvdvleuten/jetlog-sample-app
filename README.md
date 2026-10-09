# Jetlog Sample App

Jetlog is a pilot logbook for iPhone and iPad. A partner is an app or service that works with a pilot's flights. A partner connects to the logbook of a pilot with OAuth: the pilot approves the connection in the Jetlog app, and the partner gets a token it uses to call Jetlog.

This repository is a small web app that shows the whole flow, from the connect button to disconnecting. It adds a flight, reads the logbook, proposes a change to a flight the app did not add (which the pilot approves in the Jetlog app), keeps its tokens fresh, and shows every error Jetlog can answer. It is plain Node.js without dependencies, so you can read it in one sitting and port the flow to your own language.

## Run it

You need Node.js 20 or later, and the Jetlog app on an iPhone or iPad with a logbook to connect.

1. Get the code and go into the folder.

   ```sh
   git clone https://github.com/jvdvleuten/jetlog-sample-app.git
   cd jetlog-sample-app
   ```

2. Start it. There is nothing to install.

   ```sh
   npm start
   ```

3. Open http://127.0.0.1:8787 in your browser. Use that address and not `localhost`, because the sample only listens on 127.0.0.1.

The sample is registered with Jetlog as "Jetlog Sample App", so it works against https://jetlog.app as it is. You can change three settings with environment variables:

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `JETLOG_BASE_URL` | `https://jetlog.app` | The Jetlog server |
| `JETLOG_CLIENT_ID` | `https://jvdvleuten.github.io/jetlog-sample-app/client.json` | The URL of the metadata document that identifies the app |
| `PORT` | `8787` | The port the sample listens on |

The redirect address is always `http://127.0.0.1:<PORT>/callback`. The registered sample only lists port 8787, so with another port Jetlog shows an error page instead of sending you back. Your own app lists its own redirect addresses, see "Make it your own" below.

The tokens of the one local user are kept in `tokens.json` next to the code. The file is ignored by git. A real app does not do this: it keeps one record per pilot, with the refresh token in encrypted storage. Press Disconnect to start over. That also ends the connection at Jetlog, which deleting the file does not.

## What you will see

1. **The home page** has two buttons, "Own flights only" and "Whole logbook". Own flights lets the app add flights and change the flights it added itself. Whole logbook also lets it read the logbook and propose changes to flights it did not add. Pressing a button sends you to Jetlog.

2. **The Jetlog sign-in page** is called "Sign in with the Jetlog app". On a computer it shows a QR code, on a phone an "Open in Jetlog" button. A sign-in request is valid for ten minutes.

3. **The Jetlog app** opens an approval screen that names the app and says what it may do. The page shows a number, and the app asks you to tap the matching one and to confirm with Face ID or your passcode. When the app asked for the whole logbook, you also choose between "Only its own flights" and "My whole logbook", and you can always pick the smaller one.

   Approving in the Jetlog app needs a current version of the app. An older version shows "Update Jetlog to approve this sign-in". Update the app and try again, or choose "Use email instead" at the bottom of the sign-in page. That page offers the same choice.

4. **Back in the sample** the page says what was actually granted, in plain words, from the `scope` in the token response. If you asked for the whole logbook and got less, it says so and hides what the app cannot do. There are two reasons this can happen: you chose own flights only in the Jetlog app, or Jetlog has not enabled the whole logbook for the app. The second one is no error. Jetlog narrows the request by itself and answers with `scope: "import"`, so always read the scope you got.

5. **Add a flight.** Fill in a date, flight number, from and to, and press the button. The sample sends one flight to the import route and shows what Jetlog answered, including every `skipped` row and every warning. Send the same flight twice and Jetlog matches it instead of adding a second one.

6. **The logbook page** (whole logbook only) shows who is connected and the newest flights. Jetlog answers `/me` with ids only, no name and no email. The sample looks up the person with `self_person_id` in the people list and shows that name, and says so when that person is not in the list. Flights come from `/entries`, oldest first, so the sample asks for the flights of the last 60 days and follows the pages to the end to find the newest. Each flight has `is_own`, which is true when this app added it, and the page shows that in the column "Added by". For a flight the app added, the page points at the import form, which changes it directly. For every other flight it offers "Propose a change".

7. **Propose a change** (whole logbook only). Type new remarks on a flight that this app did not add and press "Propose a change". Nothing changes in the logbook. Jetlog stores the proposal and notifies the pilot. Open the Jetlog app, review the change, and approve or reject it. The status page of the sample shows `pending`, the fields the proposal changes with their value before and after, and the operations. After you decided in the app it shows `applied` or `rejected`.

   A pilot can approve only some of the operations of a proposal. Once a proposal is `applied`, every operation says whether it was applied, and the sample shows that. A proposal can also end as `expired` (nobody decided within 24 hours), `stale` (something it touches changed after it was made, nothing was applied), `failed` (applying it failed) or `revoked` (the pilot disconnected the app).

8. **Refresh and disconnect.** "Refresh the token now" exists only to show a refresh. The sample refreshes by itself a minute before the access token expires, and when Jetlog answers 401. "Disconnect" revokes the refresh token at Jetlog and deletes the stored tokens.

## How the pieces map to files

| Step | Function | File |
| :-- | :-- | :-- |
| 1. Connect: PKCE, state, resource, scope | `startConnect`, `buildAuthorizeUrl` | `src/connect.js`, `src/pkce.js` |
| 2. Callback: state, iss, `error=`, code exchange | `handleCallback` | `src/connect.js`, `src/token-endpoint.js` |
| 3. What was granted, in plain words | `describeGrant` | `src/plain-words.js` |
| 4. Import a flight | `buildImportPayload`, `importFlights` | `src/jetlog-api.js` |
| 5. Who is connected, recent flights | `getPilot` (with `getMe` and `getPeople`), `listRecentFlights` | `src/jetlog-api.js` |
| 6. Propose a change, read its status | `buildRemarksProposal`, `proposeChanges`, `getChange` | `src/jetlog-api.js` |
| 7. Tokens: refresh before expiry and on 401, one refresh at a time | `getAccessToken`, `refreshTokens`, `callWithToken` | `src/token-manager.js` |
| 8. Disconnect | `disconnect` | `src/token-manager.js` |
| 9. Errors in plain words | `explainError` | `src/errors.js` |

The rest is plumbing. `src/app.js` turns browser requests into calls to the functions above, `src/views.js` and `src/html.js` render the pages, `src/token-store.js` reads and writes `tokens.json`, `src/http.js` wraps `fetch` with a timeout, and `src/config.js` reads the environment. `docs/client.json` is the metadata document of the sample.

The refresh rules are the ones from the Jetlog guide, and each has a test:

* Refresh a minute before the access token expires, and when a call answers 401. Repeat the call once. A call made right after the pilot removed the app also answers 401. The refresh then answers `invalid_grant`, and the sample goes back to its not connected page after one refresh and no retry.
* One refresh at a time. A refresh token works once, so two refreshes would race and the loser would get `invalid_grant`.
* Write the new refresh token to storage before using anything else from the response.
* `invalid_grant` on a refresh means the connection is over. Delete the tokens.
* `unauthorized_client` on a refresh means Jetlog switched off the registration of the app. Keep the tokens, they work again when it is switched back on.

Run the tests with `npm test`. They start a small fake Jetlog on a local port, so they need no network and no account.

## Make it your own

1. **Host a metadata document** on your own domain. Its URL is your `client_id`. Copy `docs/client.json`, and use your own name and redirect addresses. It has to be served over https on port 443 with a valid certificate, answer `200` without redirects, and its `client_id` has to equal the URL it is served from. The `client_name` is at most 64 printable ASCII characters. Every redirect address is https, except `127.0.0.1`, `localhost` and `[::1]`, which are allowed for development on your own computer. Jetlog keeps a copy for 24 hours, so publish a change at least a day before you rely on it.

2. **Register the URL.** Send the URL of your metadata document to support@jetlog.app, together with the name pilots should see. Until Jetlog has registered it, an authorization request comes back to your callback with `error=unauthorized_client`. If your app needs to read the logbook or propose changes, say so in the same mail. Jetlog decides per app whether it may ask for the whole logbook. For an app without that, a request for it is not an error: Jetlog narrows it to own flights and the token response says `scope: "import"`.

3. **Use your own values.** Set `JETLOG_CLIENT_ID` to your URL, and make `redirectUri` in `src/config.js` one of the redirect addresses in your document, character for character.

4. **Pick the right redirect.** A server uses an ordinary https callback on your domain. A phone app uses an https link that the app has claimed (a universal link on iOS, an App Link on Android) and runs the sign-in in the system browser, not in a web view. A custom scheme such as `myapp://callback` is not accepted, because on iOS any app can register the same scheme and receive your authorization code.

5. **Store tokens properly.** One record per pilot. The refresh token goes in encrypted storage: the Keychain on iOS, the Keystore on Android, encrypted storage on a server. Keep tokens out of logs and URLs. If you have a phone app and a server, one of them holds the refresh token. Do not copy it to a second place, because the first refresh in either place makes the other copy useless.

The guide to the token flow, the import payload and the errors is in [JetlogAPI](https://github.com/jvdvleuten/JetlogAPI).

## Limits

* An import takes at most 200 entries and 1000 people per request. Include the `people` the entries refer to in the same request.
* A request body is at most 2 MB for an import and 256 KB for a proposal. Larger answers `413` with `{"error":"payload_too_large","max_bytes":...}`.
* A proposal holds at most 200 operations and expires after 24 hours. One connection can have at most 5 open proposals.
* A proposal may only hold the resources `entry` and `person`, and only a short list of fields, and only when the pilot would see the change. For a flight the fields are `type`, `flight_number`, `date`, `registration`, `from`, `to`, `off_blocks`, `airborne`, `touchdown`, `on_blocks`, `remarks`, `people` and `is_deleted`. On a flight that Jetlog tracks, the times and registration follow the flight feed, so a proposal for them is refused. For a person they are `first_name`, `last_name`, `default_role`, `employee_number`, `is_imported_from_other_logbook` and `is_deleted`. A new flight has `type: "flight"`. A flight can be proposed on only when it is not deleted and not a simulator session. Anything else is a `422` that names the field and the reason in plain words, and the sample shows Jetlog's own sentence.
* A proposal cannot touch files, photos, signatures or signing links. Jetlog refuses it with a 403 `insufficient_scope`, whatever the pilot would approve. The read routes send no signature, attachment or photo fields either.
* An access token lasts one hour. A refresh token lasts 90 days from the moment it is issued and is replaced on every refresh. A pilot who does not use your app for 90 days connects again.
* An authorization code is valid for 60 seconds and works once.
* Jetlog can answer `429` with a `Retry-After` header. Wait that many seconds, then send the same request again. Reading the logbook and checking the status of a proposal share one rate limit per connection. The status page of the sample does not refresh by itself, so it never polls. If yours does, back off by the `Retry-After` of a `429`.

## License

MIT, see [LICENSE](LICENSE).
