export function double(n) {
  if (n < 0) {
    return 0;
  }
  return n * 2;
}

export function greet(name) {
  return `hello ${name}`;
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/double') return new Response(String(double(Number(url.searchParams.get('n')))));
    return new Response(greet(url.searchParams.get('name') ?? 'you'));
  },
};
