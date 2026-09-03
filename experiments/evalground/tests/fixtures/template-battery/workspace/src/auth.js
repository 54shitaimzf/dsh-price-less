function checkAuth(user, token) {
  if (!user || !token) {
    throw new Error('missing credentials')
  }
  return token === user.secret
}
