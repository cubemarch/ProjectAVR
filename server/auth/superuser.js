import { users } from '../db/index.js';

/**
 * The one account that runs the deployment.
 *
 * Named by `AVR_SUPERUSER_EMAIL` and promoted at boot, which is the whole
 * design: there is no route that grants this role and there never should be.
 * An HTTP endpoint that can make somebody a superuser is an HTTP endpoint that
 * can be made to make somebody a superuser, and the thing it would be granting
 * is the ability to reserve and claim any name on the site. Putting it in the
 * environment means escalating to it requires the shell the process runs in,
 * at which point the role is the least of anybody's problems.
 *
 * It is idempotent and it is also a demotion: if the variable is cleared or
 * points somewhere else, the previous holder drops back to `admin` on the next
 * restart. A privilege that can only be granted from the environment should
 * only be revocable there too, or clearing the variable would look like it had
 * worked while the old account quietly kept everything.
 */

/** What a superuser falls back to when they stop being one. */
const DEMOTED_TO = 'admin';

/**
 * @returns {{promoted: string|null, demoted: string[]}} For the boot log.
 */
export function applySuperuser(email = process.env.AVR_SUPERUSER_EMAIL) {
    const wanted = String(email ?? '').trim().toLowerCase();
    const result = { promoted: null, demoted: [] };

    for (const existing of users.withRole('superuser')) {
        if (existing.email.toLowerCase() === wanted) continue;
        users.setRole(existing.id, DEMOTED_TO);
        result.demoted.push(existing.email);
    }

    if (!wanted) return result;

    // Case-insensitively, because addresses are stored as the account typed
    // them and the variable is typed by a different person on a different day.
    // A capital letter silently doing nothing is the worst failure this could
    // have: the log says nothing, the role never arrives, and the console the
    // role unlocks simply is not there.
    const user = users.byEmailInsensitive(wanted);

    // Not an error. A fresh deployment sets the variable before the account
    // behind it exists - which is why this returns quietly rather than
    // throwing, and why `isOperatorEmail` below is also consulted at signup.
    if (!user) return result;

    if (user.role !== 'superuser') {
        users.setRole(user.id, 'superuser');
        result.promoted = user.email;
    }

    return result;
}

/**
 * Is this the operator's own address?
 *
 * Asked at registration, which closes the one gap the boot-time pass leaves: a
 * deployment names its operator before the operator has an account, and the
 * promotion would otherwise wait for a restart nobody knows to perform. The
 * source of the privilege is unchanged - it is still the environment, and
 * still nothing a request can set.
 */
export function isOperatorEmail(email) {
    const wanted = String(process.env.AVR_SUPERUSER_EMAIL ?? '')
        .trim()
        .toLowerCase();

    return wanted !== '' && String(email ?? '').trim().toLowerCase() === wanted;
}

/** Boot-time wrapper: applies the promotion and says what it did. */
export function configureSuperuser() {
    const { promoted, demoted } = applySuperuser();

    for (const email of demoted) {
        console.log(`[auth] ${email} is no longer the superuser (now ${DEMOTED_TO})`);
    }

    if (promoted) console.log(`[auth] ${promoted} promoted to superuser`);
}
