import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../server/live/sessions.js';
import { RoomRegistry, describeDevice } from '../server/live/rooms.js';

/**
 * The waiting room and the rooms it feeds.
 *
 * The properties worth holding onto here are not "the map has an entry". They
 * are the three the design rests on: a broadcast nobody was chosen for stays
 * exactly as public as it always was, a broadcast somebody *was* chosen for is
 * watchable by that person's page and nothing else, and the phone never learns
 * any of it - the whole join happens between a grant id and a session.
 */

/** A registry pair with no timers and no relationship to the singletons. */
function stack() {
    const sessions = new SessionRegistry();
    const rooms = new RoomRegistry({ sessions });
    return { sessions, rooms };
}

let seq = 0;

function join(rooms, name = 'Dana') {
    seq += 1;
    return rooms.register({ userId: `u${seq}`, name, device: 'Apple Vision Pro' });
}

/** A broadcast as the ingest path would create it, minus the socket. */
function broadcast(sessions, grantId = null) {
    return sessions.create({
        name: 'Test broadcast',
        device: 'iPhone 17 Pro',
        mode: 'separate',
        projection: 'dome180',
        stereo: 'sbs',
        grantId
    });
}

/* ------------------------------------------------------------ the list -- */

test('a registered viewer appears on the list with a name and no secret', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms, 'Dana Okafor');
    const [listed] = rooms.waiting();

    assert.equal(listed.id, viewer.id);
    assert.equal(listed.name, 'Dana Okafor');
    assert.equal(listed.device, 'Apple Vision Pro');

    // The creator is shown ids, so an id cannot also be what admits you.
    assert.equal(listed.token, undefined);
    assert.equal(listed.userId, undefined);
    assert.ok(viewer.token.length >= 32);
});

test('the list is oldest first, so nobody is buried by arriving early', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const first = join(rooms, 'First');
    const second = join(rooms, 'Second');

    // Same millisecond is likely; make the order unambiguous.
    second.joinedAt = first.joinedAt + 1000;

    assert.deepEqual(
        rooms.waiting().map((v) => v.name),
        ['First', 'Second']
    );
});

test('a viewer that stops checking in drops off the list', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    assert.equal(rooms.waiting().length, 1);

    viewer.lastSeenAt = Date.now() - 60_000;
    assert.equal(rooms.waiting().length, 0);
    assert.equal(rooms.statusOf(viewer.id, viewer.token).status, 'unknown');
});

test('checking in keeps a viewer on the list', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    viewer.lastSeenAt = Date.now() - 10_000;

    assert.equal(rooms.statusOf(viewer.id, viewer.token).status, 'waiting');
    assert.equal(rooms.waiting().length, 1);
});

test('a wrong admission secret is not a way to read somebody else status', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);

    assert.equal(rooms.statusOf(viewer.id, 'guessed').status, 'unknown');
    assert.equal(rooms.statusOf(viewer.id, null).status, 'unknown');
    assert.equal(rooms.forget(viewer.id, 'guessed'), false);
    assert.equal(rooms.waiting().length, 1);
});

test('one account cannot fill the list from a script', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    for (let i = 0; i < 8; i += 1) {
        rooms.register({ userId: 'same', name: 'Dana', device: 'iPhone · Safari' });
    }

    assert.throws(
        () => rooms.register({ userId: 'same', name: 'Dana', device: 'iPhone · Safari' }),
        (err) => err.code === 'too_many_windows'
    );
});

/* ------------------------------------------------------------- rooms -- */

test('reserving a room takes the viewer off the list and tells them so', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    const room = rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });

    assert.equal(rooms.waiting().length, 0, 'no longer offerable to another creator');

    const state = rooms.statusOf(viewer.id, viewer.token);
    assert.equal(state.status, 'admitted');
    assert.equal(state.room.id, room.id);
    assert.equal(state.sessionId, null);
});

test('a viewer already in a room cannot be reserved by a second creator', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });

    assert.throws(
        () => rooms.reserve({ creatorId: 'creator-2', viewerId: viewer.id }),
        (err) => err.code === 'viewer_busy'
    );
});

test('a viewer who left is not reservable', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    rooms.forget(viewer.id, viewer.token);

    assert.throws(
        () => rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id }),
        (err) => err.code === 'viewer_gone'
    );
});

test('changing your mind supersedes the first room rather than opening a second', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const dana = join(rooms, 'Dana');
    const sam = join(rooms, 'Sam');

    const first = rooms.reserve({ creatorId: 'creator-1', viewerId: dana.id });
    const second = rooms.reserve({ creatorId: 'creator-1', viewerId: sam.id });

    assert.equal(rooms.byId(first.id), null, 'the abandoned room is closed');
    assert.equal(rooms.byId(second.id), second);

    // Dana is back on the list rather than stranded in a room nobody will use.
    assert.deepEqual(
        rooms.waiting().map((v) => v.name),
        ['Dana']
    );
});

test('the creator can find out why their room closed', (t) => {
    const { rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    const room = rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });

    rooms.forget(viewer.id, viewer.token);

    assert.equal(rooms.byId(room.id), null, 'closed rooms authorise nothing');
    assert.equal(rooms.peek(room.id).open, false);
    assert.equal(rooms.peek(room.id).closeReason, 'the viewer left');
});

/* --------------------------------------------------------- broadcasts -- */

test('a broadcast with no room is public and watchable by anyone', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const session = broadcast(sessions);

    assert.equal(rooms.isPrivate(session), false);
    assert.equal(rooms.mayWatch(session, null), true);
    assert.equal(rooms.mayWatch(session, 'anything'), true);
});

test('a grant with a room behind it makes its broadcast private', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    const room = rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });
    rooms.bindGrant(room, 'grant-1');

    const session = broadcast(sessions, 'grant-1');

    assert.equal(rooms.isPrivate(session), true);
    assert.equal(rooms.roomFor(session).id, room.id);

    // The phone carried a stream key and nothing else; the session id arrived
    // on this side of the join.
    assert.equal(rooms.statusOf(viewer.id, viewer.token).status, 'live');
    assert.equal(rooms.statusOf(viewer.id, viewer.token).sessionId, session.id);
});

test('only the admitted viewer secret opens a private broadcast', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const dana = join(rooms, 'Dana');
    const sam = join(rooms, 'Sam');

    rooms.bindGrant(rooms.reserve({ creatorId: 'creator-1', viewerId: dana.id }), 'grant-1');
    const session = broadcast(sessions, 'grant-1');

    assert.equal(rooms.mayWatch(session, dana.token), true);
    assert.equal(rooms.mayWatch(session, sam.token), false);
    assert.equal(rooms.mayWatch(session, dana.id), false, 'the id the creator sees is not the key');
    assert.equal(rooms.mayWatch(session, null), false);
    assert.equal(rooms.mayWatch(session, ''), false);
});

test('the room closes with the broadcast and does not wait for the next one', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    const room = rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id });
    rooms.bindGrant(room, 'grant-1');

    const session = broadcast(sessions, 'grant-1');
    session.close('phone hung up');

    assert.equal(rooms.peek(room.id).open, false);
    assert.equal(rooms.peek(room.id).closeReason, 'the broadcast ended');
    assert.equal(rooms.statusOf(viewer.id, viewer.token).status, 'waiting');
});

test('a room is found by grant before the session id is known', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    rooms.bindGrant(rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id }), 'grant-1');

    // What the transcoder sees if it happens to be the first `started`
    // listener: the session exists, but nothing has bound its id yet.
    let seenPrivate = null;
    sessions.once('started', (session) => {
        seenPrivate = rooms.isPrivate(session);
    });

    broadcast(sessions, 'grant-1');

    assert.equal(seenPrivate, true, 'privacy cannot depend on listener order');
});

test('a face check is how a room survives the round trip to the provider', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    const room = rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id, challengeId: 'chal-1' });

    assert.equal(rooms.byChallenge('chal-1').id, room.id);
    assert.equal(rooms.byChallenge('chal-2'), null);

    rooms.bindGrant(rooms.byChallenge('chal-1'), 'grant-1');
    assert.equal(rooms.isPrivate(broadcast(sessions, 'grant-1')), true);
});

test('a cancelled check leaves no room for the next grant to fall into', (t) => {
    const { sessions, rooms } = stack();
    t.after(() => rooms.detach());

    const viewer = join(rooms);
    rooms.close(rooms.reserve({ creatorId: 'creator-1', viewerId: viewer.id, challengeId: 'chal-1' }), 'cancelled');

    assert.equal(rooms.byChallenge('chal-1'), null);
    assert.equal(rooms.isPrivate(broadcast(sessions, 'grant-1')), false);
});

/* -------------------------------------------------------------- misc -- */

test('device strings say enough to tell two screens apart and no more', () => {
    assert.equal(
        describeDevice(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/120 Safari/537.36 OculusBrowser/30'
        ),
        'Meta Quest · Quest Browser'
    );
    assert.equal(
        describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/605'),
        'iPhone · Safari'
    );
    assert.equal(describeDevice(undefined), 'Unknown device');
    assert.equal(describeDevice(''), 'Unknown device');
});
