import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · SGAuth",
  description:
    "What SGAuth stores, why, who can see it, and how long it is kept.",
};

const LAST_UPDATED = "23 October 2026";
const CONTACT = "sgaOperations@northeastern.edu";

const H2 = "mt-8 text-lg font-semibold";
const P = "mt-3 leading-7";
const UL = "mt-3 list-disc space-y-2 pl-6 leading-7";

function ContactLink() {
  return (
    <a href={`mailto:${CONTACT}`} className="underline underline-offset-4">
      {CONTACT}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <h1 className="text-3xl font-semibold">Privacy at SGAuth</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated {LAST_UPDATED}
      </p>
      <p className={P}>
        SGAuth is the sign-in service for Northeastern SGA&apos;s tools. It is
        run by Northeastern SGA. This page explains what it stores about you,
        why, who can see it, and how long it is kept.
      </p>

      <section>
        <h2 className={H2}>What we store</h2>
        <ul className={UL}>
          <li>Your name and, if you set one, your preferred name.</li>
          <li>
            Your email address (a northeastern.edu address for self sign-up).
          </li>
          <li>The SGA positions you hold.</li>
          <li>
            Your password, stored only as a one-way hash, and your two-factor
            settings if you turn them on.
          </li>
          <li>
            Security information: the IP address and browser description of your
            sign-ins and sessions, and a record of security-relevant actions
            (audit events) such as sign-ins, password changes and admin changes.
          </li>
        </ul>
      </section>

      <section>
        <h2 className={H2}>What we don&apos;t store</h2>
        <p className={P}>
          SGAuth does not store your NUID, grades, class schedule, or any other
          academic record. It also does not store your phone number, pronouns,
          or photo. Names, email addresses and SGA positions are directory-level
          information. SGA is a student organization, not the university&apos;s
          FERPA records steward, and SGAuth is deliberately limited to that kind
          of data.
        </p>
      </section>

      <section>
        <h2 className={H2}>Why we store it</h2>
        <p className={P}>
          To sign you in, keep your account secure, give you the right access in
          each SGA tool based on your positions, and keep an audit trail of
          security-relevant changes.
        </p>
      </section>

      <section>
        <h2 className={H2}>Who can see it</h2>
        <ul className={UL}>
          <li>SGAuth administrators, who manage accounts and positions.</li>
          <li>
            The SGA tools you sign into, which receive your name, preferred
            name, email, positions and whether you are an administrator.
          </li>
          <li>
            Service providers that run SGAuth for us: Neon (database), Vercel
            (hosting), Resend (sending account emails) and Upstash (short-lived
            counters that limit repeated sign-in attempts).
          </li>
        </ul>
        <p className={P}>We do not sell your data or use it for advertising.</p>
      </section>

      <section>
        <h2 className={H2}>How long we keep it</h2>
        <ul className={UL}>
          <li>
            Sessions end after at most 90 days. The IP address and browser
            description on sessions and audit events are removed after 90 days.
          </li>
          <li>A deactivated account is deleted 30 days after deactivation.</li>
          <li>
            An account with no sign-in for 11 months gets an email notice and is
            deleted at 12 months if it stays unused. Administrator accounts are
            reviewed by hand instead.
          </li>
          <li>
            A self sign-up that never verifies its email is deleted after 7
            days.
          </li>
          <li>
            The browser description of a device you chose to remember, and the
            IP address of the most recent failed sign-in, are kept until your
            account is deleted.
          </li>
        </ul>
      </section>

      <section>
        <h2 className={H2}>What deletion means</h2>
        <p className={P}>
          Deleting an account removes your name, email, password, two-factor
          settings, sessions and positions, and removes IP addresses and browser
          descriptions from its audit history. An anonymous record with the same
          internal ID is kept, so that SGA tools that refer to you show
          &lsquo;Deleted user&rsquo; instead of breaking. You can sign up again
          later with the same email, as a new account.
        </p>
      </section>

      <section>
        <h2 className={H2}>Ask for your account to be deleted</h2>
        <p className={P}>
          Email <ContactLink /> from the address on your account. An
          administrator will delete it, and we will reply within 14 days.
        </p>
      </section>

      <section>
        <h2 className={H2}>Questions</h2>
        <p className={P}>
          Email <ContactLink />.
        </p>
      </section>
    </main>
  );
}
