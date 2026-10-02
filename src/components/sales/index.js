import CafeSales from "./CafeSales.jsx";
import RetailSales from "./RetailSales.jsx";
import WholesaleSales from "./WholesaleSales.jsx";
import { normalizeShopType } from "../../utils/shopTypes.js";

/** Map client shop_type → sales layout component. */
export const SALES_LAYOUT_BY_SHOP_TYPE = {
  retail: RetailSales,
  cafe: CafeSales,
  restaurant: CafeSales,
  wholesale_retail: WholesaleSales,
};

export function getSalesLayout(shopType) {
  const key = normalizeShopType(shopType);
  return SALES_LAYOUT_BY_SHOP_TYPE[key] || RetailSales;
}

export { CafeSales, RetailSales, WholesaleSales };
