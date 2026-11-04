(() => {
  const match = location.pathname.match(/^\/sites\/([a-f0-9]{32})\/?$/);
  const previewProducts = Array.isArray(window.__VAMPIRESQUID_PREVIEW_PRODUCTS__)
    ? window.__VAMPIRESQUID_PREVIEW_PRODUCTS__
    : null;
  if (!match && !previewProducts) return;
  const grid = document.getElementById("products-grid");
  if (!grid) return;
  const message = (value) => {
    const p = document.createElement("p");
    p.textContent = value;
    p.style.gridColumn = "1 / -1";
    grid.replaceChildren(p);
  };
  message("Loading this business's Stockroom products…");
  const catalog = previewProducts
    ? Promise.resolve(previewProducts)
    : fetch("/api/stockroom/public/" + match[1], { headers: { accept: "application/json" } })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Catalog unavailable");
          return Array.isArray(data.products) ? data.products : [];
        });
  catalog
    .then((products) => {
      grid.replaceChildren();
      if (!products.length) {
        message("This store has no active products yet. Please check back soon.");
        return;
      }
      for (const product of products) {
        const card = document.createElement("article");
        const art = document.createElement("div");
        art.className = "art";
        if (product.image_url) {
          const image = document.createElement("img");
          image.src = product.image_url;
          image.alt = product.name || "Product";
          image.loading = "lazy";
          image.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:7px";
          art.append(image);
        } else {
          art.textContent = "✦";
        }
        const name = document.createElement("h3");
        name.textContent = String(product.name || "Product");
        const description = document.createElement("p");
        description.textContent = String(product.description || product.category || "");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.productId = String(product.id || "");
        button.dataset.name = String(product.name || "Product");
        button.dataset.price = String(Number(product.price || 0));
        button.textContent = product.in_stock ? "Add to bag +" : "Out of stock";
        button.disabled = !product.in_stock;
        card.append(art, name, description, button);
        grid.append(card);
      }
    })
    .catch((error) => message("Products could not be loaded: " + error.message));
})();