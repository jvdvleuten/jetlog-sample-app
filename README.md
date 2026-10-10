# Jetlog Sample App

Jetlog is a pilot logbook for iPhone and iPad. A partner is an app or service that works with a pilot's flights. A partner connects to the logbook of a pilot with OAuth: the pilot approves the connection in the Jetlog app, and the partner gets a token it uses to call Jetlog.

This repository is a small web app that shows the whole flow, from the connect button to disconnecting. Against https://jetlog.app it works at the own flights level: it adds flights, changes or removes the flights it added, keeps its tokens fresh, and shows every error Jetlog can answer. It is plain Node.js without dependencies, so you can read it in one sitting and port the flow to your own language.

## What the sample shows and what it does not

Jetlog has two access levels. At the own flights level an app adds flights and changes or removes the flights it added. At the whole logbook level it can also read the logbook and propose changes to flights it did not add, which the pilot approves in the Jetlog app.

The sample runs on your own computer, and its redirect addresses are on `127.0.0.1` and `localhost`. Jetlog gives the whole logbook level only to an app that has all of these: Jetlog has switched it on for the app, the app has a client secret, its redirect addresses are approved, and none of them is a loopback address. The sample has no client secret and only loopback addresses. Against https://jetlog.app it is therefore always connected at the own flights level, also when you press "Whole logbook". It can add flights and change or remove the flights it added. It cannot read the logbook and it cannot propose changes.

The code for reading the logbook and for proposing changes is in the repository, and the tests run it against a fake Jetlog. Against https://jetlog.app it cannot be reached. An app that needs the whole logbook level has a server that keeps a client secret. The conditions, the routes and the proposals are in the [Partner API reference](https://github.com/jvdvleuten/JetlogAPI/blob/main/PARTNER_API.md#access-levels).

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

Jetlog itself registered the sample as "Jetlog Sample App", so it works against https://jetlog.app as it is, at the own flights level. You can change three settings with environment variables:

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `JETLOG_BASE_URL` | `https://jetlog.app` | The Jetlog server |
| `JETLOG_CLIENT_ID` | `https://jvdvleuten.github.io/jetlog-sample-app/client.json` | The URL of the metadata document that identifies the app |
| `PORT` | `8787` | The port the sample listens on |

The redirect address is always `http://127.0.0.1:<PORT>/callback`. The approved redirect addresses of the sample only list port 8787, so with another port Jetlog shows an error page instead of sending you back. Your own app lists its own redirect addresses, see "Make it your own" below.

The tokens of the one local user are kept in `tokens.json` next to the code. The file is ignored by git. A real app does not do this: it keeps one record per pilot, with the refresh token in encrypted storage. Press Disconnect to start over. That also ends the connection at Jetlog, which deleting the file does not.

## What you will see

1. **The home page** has two buttons, "Own flights only" and "Whole logbook". Own flights lets the app add flights and change the flights it added itself. Whole logbook asks for more: it also lets an app read the logbook and propose changes to flights it did not add. Against https://jetlog.app the second button ends at own flights too, see step 4. Pressing a button sends you to Jetlog.

2. **The Jetlog sign-in page** is called "Sign in with the Jetlog app". On a computer it shows a QR code, on a phone an "Open in Jetlog" button. A sign-in request is valid for ten minutes.

3. **The Jetlog app** opens an approval screen that names the app and says what it may do. The page shows a number, and the app asks you to tap the matching one and to confirm with Face ID or your passcode. When an app that may have the whole logbook asks for it, you also choose between "Only its own flights" and "My whole logbook", and you can always pick the smaller one. This sample may not have it, so you are not offered that choice.

   Approving in the Jetlog app needs a current version of the app. An older version shows "Update Jetlog to approve this sign-in". Update the app and try again, or choose "Use email instead" at the bottom of the sign-in page. That page offers the same choice.

4. **Back in the sample** the page says what was actually granted, in plain words, from the `scope` in the token response. Against https://jetlog.app that is always own flights, whichever button you pressed. If you pressed "Whole logbook", the page says the app asked for more and got less, and hides what the app cannot do. This is no error. Jetlog narrows the request by itself and answers with `scope: "import"`, so always read the scope you got.

   The note on that page names two possible reasons: the pilot chose own flights only in the Jetlog app, or Jetlog has not enabled the whole logbook for the app. For this sample the reason is another one. It runs on your own computer with redirect addresses on `127.0.0.1` and `localhost`, and it has no client secret, so it does not meet the conditions of the whole logbook level.

5. **Add a flight.** Fill in a date, flight number, from and to, and press the button. The sample sends one flight to the import route and shows what Jetlog answered, including every `skipped` row and every warning. Send the same flight twice and Jetlog matches it instead of adding a second one.

6. **The logbook page** (whole logbook only, not available against https://jetlog.app) shows who is connected and the newest flights. Jetlog answers `/me` with ids only, no name and no email. The sample looks up the person with `self_person_id` in the people list and shows that name, and says so when that person is not in the list. Flights come from `/entries`, oldest first, so the sample asks for the flights of the last 60 days and follows the pages to the end to find the newest. Each flight has `is_own`, which is true when this app added it, and the page shows that in the column "Added by". For a flight the app added, the page points at the import form, which changes it directly. For every other flight it offers "Propose a change".

7. **Propose a change** (whole logbook only, not available against https://jetlog.app). Type new remarks on a flight that this app did not add and press "Propose a change". Nothing changes in the logbook. Jetlog stores the proposal and notifies the pilot. Open the Jetlog app, review the change, and approve or reject it. The status page of the sample shows `pending`, the fields the proposal changes with their value before and after, and the operations. After you decided in the app it shows `applied` or `rejected`.

   A pilot can approve only some of the operations of a proposal. Once a proposal is `applied`, every operation says whether it was applied, and the sample shows that. A proposal can also end as `expired` (nobody decided within 24 hours), `stale` (something it touches changed after it was made, nothing was applied), `failed` (applying it failed) or `revoked` (the pilot disconnected the app).

8. **Refresh and disconnect.** "Refresh the token now" exists only to show a refresh. The sample refreshes by itself a minute before the access token expires, and when Jetlog answers 401. "Disconnect" revokes the refresh token at Jetlog and deletes the stored tokens.

## How the pieces map to files

| Step | Function | File |
| :-- | :-- | :-- |
| 1. Connect: PKCE, state, resource, scope | `startConnect`, `buildAuthorizeUrl` | `src/connect.js`, `src/pkce.js` |
| 2. Callback: state, iss, `error=`, code exchange | `handleCallback` | `src/connect.js`, `src/token-endpoint.js` |
| 3. What was granted, in plain words | `describeGrant` | `src/plain-words.js` |
| 4. Import a flight | `buildImportPayload`, `importFlights` | `src/jetlog-api.js` |
| 5. Who is connected, recent flights (whole logbook only) | `getPilot` (with `getMe` and `getPeople`), `listRecentFlights` | `src/jetlog-api.js` |
| 6. Propose a change, read its status (whole logbook only) | `buildRemarksProposal`, `proposeChanges`, `getChange` | `src/jetlog-api.js` |
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

1. **Host a metadata document** on your own domain. Its URL is your `client_id`. Copy `docs/client.json` and use your own name and redirect addresses. It has to be served over https on port 443 with a valid certificate, answer `200` without redirects, and its `client_id` has to equal the URL it is served from. Every redirect address is https, except `127.0.0.1`, `localhost` and `[::1]`, which are allowed for development on your own computer. Jetlog keeps a copy for 24 hours, so publish a change at least a day before you rely on it.

   Your document also needs a `"jetlog_developer"` field, with the verification value that the console gives you in the next step. The sample's own `docs/client.json` has no such field, because Jetlog registered the sample itself. A document of your own needs it.

2. **Register your app in the developer console.** Read about it at https://jetlog.app/developers and open the console at https://jetlog.app/developers/console.

   * Sign in with the email address of your Jetlog account. The console mails you a code. You need a Jetlog account, because the console does not create one.
   * The console shows a verification value that starts with `jld_`. Put it in your metadata document as `"jetlog_developer"`. It is the same for every app you register. It is not a secret and not a key, it only shows that the document is yours. Jetlog checks it when you submit and again when it approves the app.
   * Fill in the name pilots will see and the address of your document. The name is at most 64 printable ASCII characters. It cannot contain "Jetlog", cannot contain `/ : @ < >` and cannot start with `www.`. The sample is called "Jetlog Sample App" only because Jetlog registered it itself.
   * Press "Check document". It fetches your document and lists every problem in plain words. Submitting runs the same check.
   * Submit and wait. Jetlog reviews every app and emails you the decision. Until the app is approved, an authorization request for it comes back to your callback with `error=unauthorized_client`.

   After you have submitted, the name and the address cannot be changed. Register a new app, or write to support@jetlog.app. You can have at most 5 apps, and register at most 5 per day.

3. **Ask for the whole logbook only if your app has a server.** Every approved app can add flights and change the flights it added. Reading the logbook and proposing changes is a second level. Jetlog gives it to an app that has all of these:

   * Jetlog has switched it on for the app. You ask for it on the app's page in the console, with a short reason, once the app is approved. Jetlog decides and mails you.
   * The app has a client secret, which you generate on the same page. The secret stays on your server and goes in the body of every request to the token endpoint, as `client_secret`, for the code exchange and for every refresh.
   * The redirect addresses of the app are approved, and none of them is a loopback address.

   This sample sends no client secret and has only loopback redirect addresses, so a copy of it with your own values still works at the own flights level. For an app that does not meet the conditions, a request for the whole logbook is not an error: Jetlog narrows it to own flights and the token response says `scope: "import"`. The conditions, the routes and the proposals are in the [Partner API reference](https://github.com/jvdvleuten/JetlogAPI/blob/main/PARTNER_API.md#access-levels).

   The redirect addresses in your document at the moment of approval are the approved ones. Adding or changing one later does not take effect until Jetlog has approved it, so write to support@jetlog.app. An authorization request with an address that is not approved gets the Jetlog error page.

4. **Use your own values.** Set `JETLOG_CLIENT_ID` to your URL, and make `redirectUri` in `src/config.js` one of the approved redirect addresses, character for character.

5. **Pick the right redirect.** A server uses an ordinary https callback on your domain. A phone app uses an https link that the app has claimed (a universal link on iOS, an App Link on Android) and runs the sign-in in the system browser, not in a web view. A custom scheme such as `myapp://callback` is not accepted, because on iOS any app can register the same scheme and receive your authorization code.

6. **Store tokens properly.** One record per pilot. The refresh token goes in encrypted storage: the Keychain on iOS, the Keystore on Android, encrypted storage on a server. Keep tokens out of logs and URLs. If you have a phone app and a server, one of them holds the refresh token. Do not copy it to a second place, because the first refresh in either place makes the other copy useless.

The guide to the token flow, the import payload and the errors is in [JetlogAPI](https://github.com/jvdvleuten/JetlogAPI).

## Limits

At every level:

* An import takes at most 200 entries and 1000 people per request. Include the `people` the entries refer to in the same request.
* A request body is at most 2 MB for an import. Larger answers `413` with `{"error":"payload_too_large","max_bytes":...}`.
* An access token lasts one hour. A refresh token lasts 90 days from the moment it is issued and is replaced on every refresh. A pilot who does not use your app for 90 days connects again.
* An authorization code is valid for 60 seconds and works once.
* Jetlog can answer `429` with a `Retry-After` header. Wait that many seconds, then send the same request again.

At the whole logbook level only. The sample cannot reach this level against https://jetlog.app, and the tests run these rules against a fake Jetlog:

* A request body is at most 256 KB for a proposal. Larger answers `413` as well.
* A proposal holds at most 200 operations and expires after 24 hours. One connection can have at most 5 open proposals.
* A proposal may only hold the resources `entry` and `person`, and only a short list of fields. For a flight the fields are `type`, `flight_number`, `date`, `registration`, `from`, `to`, `off_blocks`, `airborne`, `touchdown`, `on_blocks`, `remarks`, `people` and `is_deleted`. For a person they are `first_name`, `last_name`, `default_role`, `employee_number`, `is_imported_from_other_logbook` and `is_deleted`. A new flight has `type: "flight"`. A flight can be proposed on only when it is not deleted and not a simulator session. Two operations on the same id in one proposal are refused.
* The rule behind that list: after the pilot approves, the logbook must show exactly the value the app proposed, or Jetlog refuses the proposal. Repeating a value that is already there is accepted. On a flight that follows the flight feed, the feed decides the date, route, registration and times, so a proposal for those is refused unless it repeats what the logbook shows. A refusal is a `422` that names the field, and the sample shows Jetlog's own sentence.
* A proposal cannot touch files, photos, signatures or signing links. Jetlog refuses it with a 403 `insufficient_scope`, whatever the pilot would approve. The read routes send no signature, attachment or photo fields either.
* Reading the logbook and checking the status of a proposal share one rate limit per connection. The status page of the sample does not refresh by itself, so it never polls. If yours does, back off by the `Retry-After` of a `429`.

## License

MIT, see [LICENSE](LICENSE).
