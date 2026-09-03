function checkAuth(user, token) {
  if (!user || !token) {
    return false
  }
  return token === user.secret
}
