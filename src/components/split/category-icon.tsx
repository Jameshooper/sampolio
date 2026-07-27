'use client';

import type { ReactNode } from 'react';
import {
  MdShoppingCart, MdRestaurant, MdLocalBar, MdChair, MdDevices, MdVpnKey, MdHouse,
  MdBolt, MdWaterDrop, MdLocalFireDepartment, MdWifi, MdBuild, MdCleaningServices,
  MdHome, MdDirectionsBus, MdTrain, MdLocalTaxi, MdDirectionsCar, MdLocalGasStation,
  MdLocalParking, MdFlight, MdHotel, MdLuggage, MdCelebration, MdMovie, MdMusicNote,
  MdSportsEsports, MdFitnessCenter, MdCheckroom, MdCardGiftcard, MdLocalHospital,
  MdShield, MdSchool, MdMiscellaneousServices, MdSwapHoriz, MdReceiptLong,
} from 'react-icons/md';

const ICONS: Record<string, ReactNode> = {
  Groceries: <MdShoppingCart />,
  'Dining out': <MdRestaurant />,
  Liquor: <MdLocalBar />,
  'Household supplies': <MdCleaningServices />,
  Furniture: <MdChair />,
  Electronics: <MdDevices />,
  Rent: <MdVpnKey />,
  Mortgage: <MdHouse />,
  Utilities: <MdBolt />,
  Electricity: <MdBolt />,
  Water: <MdWaterDrop />,
  Heating: <MdLocalFireDepartment />,
  'TV/Phone/Internet': <MdWifi />,
  Maintenance: <MdBuild />,
  Cleaning: <MdCleaningServices />,
  'Home - Other': <MdHome />,
  Transport: <MdDirectionsBus />,
  'Bus/train': <MdTrain />,
  Taxi: <MdLocalTaxi />,
  Car: <MdDirectionsCar />,
  Fuel: <MdLocalGasStation />,
  Parking: <MdLocalParking />,
  Plane: <MdFlight />,
  Hotel: <MdHotel />,
  Travel: <MdLuggage />,
  Entertainment: <MdCelebration />,
  Movies: <MdMovie />,
  Music: <MdMusicNote />,
  Games: <MdSportsEsports />,
  Sports: <MdFitnessCenter />,
  Clothing: <MdCheckroom />,
  Gifts: <MdCardGiftcard />,
  Medical: <MdLocalHospital />,
  Insurance: <MdShield />,
  Education: <MdSchool />,
  Services: <MdMiscellaneousServices />,
  Payment: <MdSwapHoriz />,
};

/** Tinted rounded-square icon for a split category (Splitwise-style ledger tile). */
export function CategoryIcon({ category, size = 40 }: { category: string; size?: number }) {
  const icon = ICONS[category] ?? <MdReceiptLong />;
  return (
    <span
      className="flex items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      aria-hidden
    >
      {icon}
    </span>
  );
}
