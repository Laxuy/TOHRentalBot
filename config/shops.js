const shops = {
  toh: {
    name: "TOH Motorbike Rental",
  },
};

function getShop(shopId) {
  const shop = shops[shopId];
  if (!shop) throw new Error(`Unknown shop: ${shopId}`);
  return shop;
}

module.exports = { shops, getShop };
