<template>
  <a class="skip-link" href="#main-content">跳到内容</a>
  <header class="public-header">
    <RouterLink class="brand" to="/downloads">构建平台</RouterLink>
    <nav aria-label="公开页面导航">
      <RouterLink to="/downloads">项目下载</RouterLink>
      <RouterLink to="/login">登录</RouterLink>
    </nav>
  </header>
  <main id="main-content" class="public-content" tabindex="-1">
    <RouterView />
  </main>
</template>
