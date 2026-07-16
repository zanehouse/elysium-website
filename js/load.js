console.log(document.querySelectorAll('.reveal'));

if ('IntersectionObserver' in window) {

  const observer = new IntersectionObserver((entries) => {

    entries.forEach(entry => {

      console.log("Intersecting:", entry.isIntersecting);

      if (entry.isIntersecting) {
        entry.target.classList.add('active');
        observer.unobserve(entry.target);
      }

    });

  }, {
    threshold: 0.01,
    rootMargin: "0px 0px -50px 0px"
  });

  document.querySelectorAll('.reveal').forEach(el => {
    observer.observe(el);
  });

} else {

  // Fallback if IntersectionObserver is not supported
  document.querySelectorAll('.reveal').forEach(el => {
    el.classList.add('active');
  });

}