// The ONLY way a User row may leave the server.
//
// It is a whitelist (copy the safe fields) rather than a blacklist (delete
// passwordHash): if someone adds a sensitive column later, it stays hidden
// until they deliberately add it here.
export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
  };
}
