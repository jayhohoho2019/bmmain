const menu = document.querySelector('.menu');
const nav = document.querySelector('.site-header nav');
menu?.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menu.textContent = open ? 'Close' : 'Menu';
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('visible'));
}, { threshold: 0.12 });
document.querySelectorAll('.reveal, .product-card, .detail-section, .solution-grid article, .values article').forEach(el => observer.observe(el));
