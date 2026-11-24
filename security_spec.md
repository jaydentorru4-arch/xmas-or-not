# Hollow Eve — Firestore Security Specification

## Data Invariants
1. Public survivor profiles (`/users/{userId}/public/profile`) contain zero PII (`email` is strictly isolated in `/users/{userId}/private/info` readable only by `userId`).
2. Every chat message (`globalChat` and `rooms/{roomId}/messages`) requires `email_verified == true`, `senderId == request.auth.uid`, bounded `text` (`1..240` chars), and server timestamp `request.time`.
3. Room messages require active room membership (`exists(/databases/$(database)/documents/rooms/$(roomId)/players/$(request.auth.uid))`).
4. Room Santa state (`/rooms/{roomId}/santa/live`) may only be written by the parent room's `hostId`.
5. Room `collectedOrnaments` list is strictly bounded (`<= 10` elements) and updates are denied once `status == 'finished'`.
6. All document IDs (`userId`, `roomId`, `playerId`, `messageId`) match `^[a-zA-Z0-9_\-]+$` and `<= 128` chars.

## Dirty Dozen Adversarial Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Write**: Create room with `request.auth == null`.
2. **Unverified Email**: Create room with `email_verified: false`.
3. **PII Leak Read**: User B attempts `get` on `/users/userA/private/info`.
4. **Identity Spoof (Profile)**: User B writes `/users/userA/public/profile` with `uid: "userB"`.
5. **Shadow Field Injection**: Create `PublicProfile` with extra ghost field `isAdmin: true`.
6. **Client Timestamp Forgery**: Create `GlobalChatMessage` with custom past `createdAt` instead of `request.time`.
7. **ID Poisoning**: Create `rooms/bad$id!!` with invalid characters or length > 128.
8. **Chat Impersonation**: User B sends `RoomChatMessage` with `senderId: "userA"`.
9. **Non-Member Room Chat**: User C (not in `rooms/room1/players`) attempts to post in `rooms/room1/messages`.
10. **Non-Host Santa Hijack**: Non-host player attempts to write `/rooms/room1/santa/live`.
11. **Terminal State Mutation**: Any user attempts to update a room after `status == 'finished'`.
12. **Unbounded Array / Payload DoS**: Update `collectedOrnaments` with 50 items or send a 5,000-char chat `text`.
