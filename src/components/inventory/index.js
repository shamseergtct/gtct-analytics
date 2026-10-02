import CafeInventory from "./CafeInventory.jsx";
import RetailInventory from "./RetailInventory.jsx";
import WholesaleInventory from "./WholesaleInventory.jsx";
import { normalizeShopType } from "../../utils/shopTypes.js";

export const INVENTORY_LAYOUT_BY_SHOP_TYPE = {
  retail: RetailInventory,
  cafe: CafeInventory,
  restaurant: CafeInventory,
  wholesale_retail: WholesaleInventory,
};

export function getInventoryLayout(shopType) {
  const key = normalizeShopType(shopType);
  return INVENTORY_LAYOUT_BY_SHOP_TYPE[key] || RetailInventory;
}

export { CafeInventory, RetailInventory, WholesaleInventory };
