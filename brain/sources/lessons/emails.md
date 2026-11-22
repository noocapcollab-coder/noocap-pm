# PM lessons: Emails

Mistakes the PM made once and the rule that came out of each.

## A fixed reply never promises work that is already done
When: A fixed reply (contract ack, ETA reply) is about to go on a deal where the script, cut or other item it mentions has already been sent or approved
Do: Check the deal's Script Sent Date, stage and history first and cut any line that promises something the brand already has. Keep Deal Memory's 'We owe' to what is really still owed.
Never: Tell a brand 'we'll share the script' (or the cut) after it was sent and approved, or write that promise into Deal Memory as something we owe.
Seen 1 time(s). Source: System check.
## Send signed contracts to the brand, never the creator
When: Sending a signed influencer agreement or contract email
Do: Send agreement emails only to the brand contact or agency handling the contract, never back to the creator or their team inbox
Never: Send signed contracts back to the creator or their management team
Seen 1 time(s). Source: Draft rejected.
## Do not send unneeded reply emails when already answered or nothing to say
When: Drafting or sending an email reply
Do: Check if the thread or deal already has our response or if no reply is needed before drafting; drop unnecessary replies.
Never: Send unneeded or duplicate reply emails when the thread requires no further answer
Seen 1 time(s). Source: Draft rejected.
## Never agree to the brand's timeframe on our own
When: A brand asks whether the video can be made within their window (this week or next, by a deadline)
Do: Send the timeline ask to Harsh on WhatsApp and write only from his answer
Never: Reply 'yes, we can do it within this timeframe', 'we can meet your deadline' or 'that timeline works' when Harsh gave no timeline
Seen 1 time(s). Source: System check.
## Wrong details we sent are corrected before the brand's document is signed
When: We sent a brand wrong facts (a creator's name, address, rate or date) and the brand answers with a document built on them, such as an agreement or invoice form
Do: Keep the correction alive after the brand's next email: answer that email with the right facts, ask them to fix the document, and tell Harsh on WhatsApp in the contract message that the document carries the wrong details so he does not sign it
Never: Retire the correction because the brand wrote again, or file the brand's document as ready to sign without saying it repeats our mistake
Seen 1 time(s). Source: System check.
## Never invent a creator's legal or business details
When: A brand asks for the creator's business name, legal name, legal address, contact email, tax ID or bank details (for an agreement, invoice or vendor form), in any email the PM writes
Do: Leave those details out of the email and ask Harsh on WhatsApp for them; answer the rest of the email (the script, the cut). Only details Harsh gave, or ones already on file word for word, ever go to a brand.
Never: Fill in a name, company, address or email that is not on file (no 'Lindsay Creative LLC', '123 Maple Street', 'name@noocap.com'), and never put agreement details inside a script, follow-up, tool-access or cut email.
Seen 2 time(s). Source: System check.
## An e-sign notice gets no reply email
When: An automated signing service (agreements@, PandaDoc, DocuSign, a 'Please sign' or 'Completed' notice with a sign link) emails a contract for a creator
Do: Send the contract and sign link to Harsh on WhatsApp once and link it to the right deal; a 'Completed' notice only records that it is signed.
Never: Never draft a reply to the signing service's address, never greet the campaign contact in it, and never promise to review or sign it 'shortly'.
Seen 1 time(s). Source: System check.
## A loop-in reply asks only for what the brand hasn't sent
When: A creator's team loops noocapcollab into a brand thread
Do: Check the thread for a brief link or file and an attached contract, and ask only for what is missing
Never: Never ask the brand for a brief or contract that is already in the thread
Seen 1 time(s). Source: Harsh correction.
## A rejected draft waits for a new email before it is written again
When: Any draft that Harsh or the system check rejected, or that expired
Do: Draft it again only once the brand or we send a new email in that deal (the 3-day cooldown still caps the wait)
Never: Never write the same kind of email for the same deal again just because a day has passed and nothing in the thread changed
Seen 1 time(s). Source: Harsh correction.
## Ask Harsh before drafting an answer to a brand question
When: A brand email asks us something, inside a brief, script approval or video feedback
Do: Ask Harsh on WhatsApp with the brand's words and draft the email from his answer
Never: Never write an AI reply to the question before Harsh has answered it, because those drafts were rejected almost every time and cost two AI calls each
Seen 1 time(s). Source: Harsh correction.
## A script, invoice or file email is never held for a missing attachment
When: The second check reads a Script, Invoice or File email before it reaches Approvals
Do: Remember the file goes on at send time (Script PDF from the card, Invoice from Stripe, Send File); judge the email with that file attached.
Never: Hold a Script, Invoice or File email because the draft itself has no attachment yet.
Seen 1 time(s). Source: System check.
## A cut email also repeats any answer we already gave to the brand's open question
When: A cut goes to the brand while the brand's latest message asks something our own earlier emails already answered (an account email, a code, a link)
Do: Hand over the cut and repeat that answer in one short sentence, word for word as we gave it. Read our own sent emails in the thread before saying anything is missing
Never: Never tell the writer to answer nothing else while the second check demands the question be answered: the two rules together held every cut for a brand with an open question
Seen 1 time(s). Source: Harsh correction.
## Don't send 'ignore this' emails unless the error is critical
When: An email was sent to the wrong thread or contained a minor mistake.
Do: If an email was sent by mistake, only send a correction if the brand is likely to be confused or act on the error. If it is minor or they have not noticed, stay silent to avoid calling attention to a mistake that might have gone unnoticed.
Never: Send an 'ignore the last email' correction for minor errors or if the brand is likely to have ignored or missed it.
Seen 1 time(s). Source: Draft rejected.
## A quoted line or a broken-up link is never the brand's question
When: Reading what a brand asks in its newest email
Do: Cut the quoted history at a wrapped 'On ... wrote:' line and at the first '>' line, and ignore leftover pieces of links, before taking a question from the email
Never: Show Harsh our own quoted question, or a link fragment like 'd/12PP.../edit?', as the brand's question
Seen 2 time(s). Source: System check.
## Trial and tool accounts brands ask for go to noocaptools@gmail.com
When: A brand asks which email to use for a trial account, Pro access, credits or a tool login for the creator
Do: Give noocaptools@gmail.com
Never: Never give the creator's personal or business email (like duncan@buildroom.ai) for a trial account
Seen 1 time(s). Source: Harsh correction.
## One send per draft: an email that is already being sent can't be sent again
When: Any send of a PM OUTBOX draft (Send in Approvals, WhatsApp send, sendoutbox hook, auto-send)
Do: Each send writes its own claim into Error, waits 2 seconds and reads it back; only the send whose claim is still there goes ahead, and a fresh claim (under 3 minutes) blocks any other send
Never: Never send a draft that another send has already claimed, and Claude never calls sendoutbox on a draft sitting in Approvals without first checking Harsh hasn't already pressed Send
Seen 1 time(s). Source: Harsh correction.
## Publish-date confirmations send on their own
When: The brand has approved the content and asks us to confirm we're ready to publish or when it goes live
Do: Send the fixed reply publish_date_confirm with the video card's POST DATE, no approval needed
Never: Never hold this for Harsh, never write a date that isn't the card's POST DATE, never send it when the card has no date
Seen 1 time(s). Source: Harsh correction.
## A brand email nobody answered stays unread
When: A brand email asks something of us (a question, a date, a confirmation, a reply) and the PM sends no reply and drafts none
Do: Leave it unread in noocapcollab Gmail so Harsh sees who is waiting, and only mark read once a reply went out or is in Approvals
Never: Never mark a waiting brand email read just because it was filed, logged or already seen by another run
Seen 1 time(s). Source: Harsh correction.
## A brand chasing a promised posting gets a time from Harsh, never 'today' or 'finishing touches'
When: A brand asks when the approved video goes live, or chases a posting we said would happen today
Do: Give the posting time Harsh supplied, otherwise ask Harsh on WhatsApp for it before replying
Never: Write 'we will post it today/tomorrow/soon/now', 'Chris will post it today', 'we are going ahead and posting it now', 'we are posting it today', 'we're getting it posted right now', 'we are putting the finishing touches' or 'we're finalizing the video' without a time Harsh gave
Seen 3 time(s). Source: System check.
## A fixed reply in Harsh's own words sends on its own, timing line included
When: Saving a Reply Templates reply (Why has [template:...]) such as billing_on_approval
Do: Hold a fixed reply only for a leftover placeholder or a made-up code; let it auto-send otherwise, and record the deal's ask (Billing Request Sent) only when the copy really went
Never: Mark a fixed reply Needs you for its own timing line, or count a copy still waiting in Approvals as sent
Seen 1 time(s). Source: System check.
## Content emails go to the content contact, money emails to the billing contact
When: A brand splits contacts (one person for script and video, another for invoices and payment)
Do: Send scripts, cuts and content follow-ups To the content contact (the person the email greets); send invoices and payment chases to the billing email; keep the other on Cc
Never: Never let a billing contact replying about an invoice take over the deal's Brand Email for content emails
Seen 1 time(s). Source: Harsh correction.
## Every loop-in gets our take-over reply
When: A creator (or their team) loops noocapcollab into a brand thread, in any wording: loop in, looped in, cc'd, added, take it over
Do: Open the deal and send the fixed loop-in reply from noocapcollab: we'll take it forward from here, please share the brief and contract in this thread
Never: Never treat a loop-in as 'still a lead, brand hasn't agreed' because the wording was past tense or slightly different
Seen 1 time(s). Source: Harsh correction.
## Reply to the correct person in their own thread
When: Drafting a reply to a brand thread
Do: Double-check the deal's recipient history and send replies only to the person who wrote the last message in the correct brand thread.
Never: Send an email to the wrong contact or mix up threads when multiple conversations exist
Seen 1 time(s). Source: Draft rejected.
## Keep chasing an interested brand until they answer
When: A brand has agreed (we accepted their rate, or the creator said yes) and owes us the contract, brief or script approval
Do: Follow up every 3 days until they answer. A contract or brief follow-up 3+ days after our last email is never too early.
Never: Never stop after a set number of follow-ups, never let a stale stage (Negotiating) or an empty Last Our Reply stop the chase, and never hold a contract follow-up as too soon.
Seen 1 time(s). Source: Harsh correction.
## Chris's inbox is collab@chriscordero.net, and a Message-ID is never an address
When: Building To or Cc for any email, from a thread where a brand mistyped one of our inboxes or where a Message-ID slipped into the address list
Do: Use our real inboxes (collab@chriscordero.net, collab@buildroom.ai, partnerships@ninjaaitools.com, collab@automateaiconsulting.com, collab@valchy.ai) and drop anything @mail.gmail.com
Never: Copy a brand's typo of our address (ollab@chriscordero.net) or a Message-ID into Thread CC
Seen 1 time(s). Source: Harsh correction.
## A tool-access email never replaces an answer to the brand's question
When: A brand approves the script (or reminds us it approved it) and asks something else: when the video draft or content comes, a date, a file
Do: Hold the tool-access email and send the brand's question to Harsh first; when his answer comes, put the access ask in the same reply.
Never: Draft or send 'thanks for approving, please give access on noocaptools@gmail.com' as the only reply to an email that asked us a question.
Seen 2 time(s). Source: System check.
## Sign as the creator the brand is now working with
When: A deal's video moved to another creator (a mix-up, a swap) and the PM writes to the brand
Do: Sign and refer to the one creator the brand was last told about ("Brad's Team" once we told them Brad shoots it), and flag the deal so its Creator field can be corrected.
Never: Name one creator in the body and sign with another creator's team, which repeats the mix-up the brand already complained about.
Seen 2 time(s). Source: System check.
## No tool-access ask when the brand already gave us an account
When: A brand approves a script and the PM is about to ask for access to their tool on noocaptools@gmail.com
Do: Read the thread first: if the brand already shared a login or trial account (email and password), or an earlier email of ours already asked for access on noocaptools@gmail.com (any earlier campaign in the same thread, the account stays on), skip the tool-access email. Greet the contact by the name they sign with, never by a non-Latin display name.
Never: Ask for access the brand already gave, or greet someone by their email display name ("Hi 이승주") when they sign as "Seungjoo".
Seen 2 time(s). Source: System check.
## Never say 'here is' something the email does not carry
When: A brand asks for a file, image, caption, link or document we don't have on the deal yet
Do: Only write 'here is X' or 'attached is X' when X is attached or pasted in the email. If we don't have it, ask Harsh for it and draft the reply once it arrives.
Never: Draft 'Here is the cover image and caption' (or any 'please find attached') with nothing attached, and never label a request as the brand only acknowledging receipt.
Seen 2 time(s). Source: System check.
## An email that just went out is never drafted a second time
When: The PM is about to write a script, follow-up or other email on a deal where one of the same kind was sent in the last few hours
Do: Check PM OUTBOX for a Sent row of the same kind on the deal before drafting. A sent row means the job is done, even if the deal fields have not caught up yet.
Never: Write a second copy of the same email minutes after the first auto-sent because the deal's Script Sent Date or Last Our Reply was not updated yet.
Seen 1 time(s). Source: System check.
## A nudge is dead once the brand answers it, even minutes before it sends
When: A follow-up, tool-access nudge or check-in has finished its 30-minute hold and is about to send
Do: Look at the thread itself for a brand email newer than the draft right before sending; if there is one, retire the nudge and read their email
Never: Never send 'any news on access?' after the brand has written that access is given
Seen 1 time(s). Source: System check.
## Never give a brand a code, ID, status or date nobody supplied
When: Writing any email that would contain a UID, account ID, promo or ad code, link, production status (filming, editing), an agreed date, or a confirmation that we tried something (logged in, accessed an account, received credits)
Do: Use only values that appear word for word in the brand's email, the deal, the video card or Harsh's WhatsApp answer. If the brand asked for one we don't have, leave it out of the email and ask Harsh on WhatsApp for it
Never: Never make up a number or code, never say we are filming when the card is not past 6- To Film, never accept a new post date Harsh has not agreed, never confirm we can access an account or tool nobody on our side has said they logged in to
Seen 2 time(s). Source: System check.
## An email held for a second read still counts as the brand writing last
When: The two readers disagree on what a brand email means and the email is held for Harsh
Do: Record the brand's reply on the deal anyway (Last Brand Reply, Message ID, Follow-ups Sent back to 0) and read the held email before drafting any follow-up on that deal
Never: Never send a follow-up or check-in on a deal whose newest brand email is held or unread, and never ask a brand for feedback it already gave
Seen 1 time(s). Source: System check.
## Never invent terms the thread never set
When: Replying to a brand's brief or question about timing
Do: Only state timelines and conditions that the thread or Deal Memory already holds; if the brief asks for a pick or a date the team or Harsh decides, leave it to the script or ask Harsh
Never: Write conditions like 'within 3 business days of the signed agreement and deposit' when no agreement or deposit was ever discussed, or re-ask our own last question back to the brand
Seen 2 time(s). Source: System check.
## Never say we sent something we only asked for
When: Writing a follow-up or reply that refers to an earlier step (a contract, brief, script, invoice)
Do: Check the deal history for who sent it. If the brand still owes it, name it as theirs: 'any news on the contract and brief from the OiiOii team?'
Never: Never write 'the brief and contract we sent' when our email only asked for them, and never record our ask as 'us: sent contract' in Deal Memory.
Seen 1 time(s). Source: System check.
## An email we send only answers what it was about
When: The PM sends an automatic email (tool access, follow-up, script) in a thread where another draft is waiting with a brand question for Harsh
Do: Keep the waiting question alive: the auto email only closes drafts of its own kind, and a brand question about a date, money or files still goes to Harsh on WhatsApp.
Never: Let an automatic email silently reject a 'Needs you' reply that carried the brand's question.
Seen 1 time(s). Source: System check.
## A follow-up waits from our newest email, even one sent minutes ago
When: Deciding whether a brand has gone quiet long enough for a follow-up, especially in the same run that just sent a cut or script
Do: Count the wait from the latest email we sent in the thread (the cut or script just sent included) and only chase 3 days after it
Never: Never draft a 'have you had a chance to review' follow-up right after we delivered something, counted from an older Last Our Reply
Seen 4 time(s). Source: System check.
## No follow-up to the brand while we owe the next cut or script
When: A cut or script went to the brand, they sent changes (or asked for a reshoot or a revised script), and our team is working on it, even if the card or deal stage still says we are waiting on them.
Do: Treat the EDIT TRACKER row on Changes (or a Next Action like "editor making the brand's changes" or a reshoot) as our move. Send the revised cut when it is done; if it is late, tell Harsh once.
Never: Never send the brand a check-in that only repeats our last email or promises the cut 'in the next few days'.
Seen 3 time(s). Source: System check.
## A follow-up counts from the brand's newest message, in any inbox
When: A brand writes on a deal from or to the creator's own inbox (not the noocapcollab thread), e.g. 'sent it to the client for review'
Do: Record that message on the deal (Last Brand Reply, memory) and wait 3 days from it before a gentle nudge that acknowledges what they said.
Never: Send 'do you have any feedback yet?' hours after the brand told us the script is with their client.
Seen 2 time(s). Source: System check.
## Count every follow-up in the thread, not just the counter
When: Deciding whether to send another follow-up on a script or video the brand hasn't answered
Do: Count the follow-ups in the deal's history since the brand last wrote (including ones sent by hand). At 5 for a script, stop and hand it to Harsh once.
Never: Draft a follow-up numbered from a stale counter, or promise to start work 'right away' to push a silent brand.
Seen 1 time(s). Source: System check.
## A waiting draft dies once the brand has moved past it
When: A draft is waiting in Approvals and the brand writes again on that deal (in any of our inboxes, including the creator's own)
Do: Before a waiting draft goes out, read the brand's newest message on the deal and the matching Lead. If it answers or overtakes the draft (they got the file, they forwarded it to the client, they asked something new), reject the draft and answer the newest email instead.
Never: Leave a 'did you get it?' or 'just making sure this reached you' draft waiting after the brand has already confirmed receipt or acted on it.
Seen 1 time(s). Source: System check.
## Answer the brand's newest email, to the person who wrote it
When: Replying in a thread where the brand's latest email changes the subject (hands payment to a colleague, pitches a new brand, asks a rate)
Do: Read the newest message first. Greet and address whoever wrote it, answer exactly what it asks, and send a rate or new-brand question to Harsh (it opens its own Inbound deal).
Never: Answer an older question nobody asked again, greet someone who did not write, or skip the question the brand actually asked.
Seen 8 time(s). Source: System check.
## Copy the deal's full Thread CC on every draft
When: Writing any email to a brand, including a resend from a creator's inbox
Do: Put every address in the deal's Thread CC into Cc, plus noocapcollab when the brand was asked to reply all.
Never: Send with only part of the Thread CC, or drop the creator's own team address.
Seen 1 time(s). Source: System check.
## Sign and greet correctly
When: Writing any email
Do: Sign as the deal's own creator ('Best, Lindsay's Team'). Greet by first name only when the brand signed with it, else 'Hi there,'.
Never: Sign as another creator, leave <UNKNOWN>, or take a name from an email address or brand name.
Seen 2 time(s). Source: Rulebook.
## Go-live dates come from the video card
When: Mentioning when a video posts
Do: Use the video card's POST DATE, and only when it is given in the facts.
Never: Use the deal's Deadline or a date from an old email.
Seen 1 time(s). Source: Rulebook.
## No dashes in emails
When: Writing any email
Do: Use commas, full stops or 'and'.
Never: Use em or en dashes.
Seen 1 time(s). Source: Rulebook.
## Keep Approvals short
When: Drafts wait in Approvals
Do: Let unsent first replies to brand pitches expire after 5 days; reject drafts that the thread already moved past.
Never: Leave stale drafts piling up.
Seen 3 time(s). Source: Rulebook.
## Reply in the brand's existing thread
When: Sending any email to a brand
Do: Reply in the thread the deal already has (Thread ID / Message ID).
Never: Start a new thread when one exists.
Seen 3 time(s). Source: Rulebook.
## Chase every cut that is with the brand
When: A cut was sent for approval and the brand is silent
Do: Follow up on the normal rhythm, even if an earlier reel of the deal is posted.
Never: Treat the deal as done because reel 1 is posted.
Seen 1 time(s). Source: Rulebook.
## Address the brand contact of this deal
When: Writing or editing a brand email
Do: Send to whoever at THIS brand wrote last in THIS thread.
Never: Use another brand's address, or apply a message about one brand to another brand's draft.
Seen 3 time(s). Source: Rulebook.
## No filler promises or placeholders
When: Writing any email
Do: Give the thing if we have it, otherwise leave the promise out.
Never: Write 'shortly', 'within a few hours', 'we'll send it today', [DATE], [name] or invented dates.
Seen 21 time(s). Source: Rulebook.
