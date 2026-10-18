/**
 * The UI's icon set: Phosphor, Light weight (the light stroke matches the hairline borders and 400–590 type weights).
 * Every icon goes through this file, so swapping the set or the weight is a change here only.
 *
 * `/ssr` entry: no React context, so the icons render in server and client components alike. Size comes from the
 * `size-*` class, colour from `currentColor`.
 */
import type { IconProps } from "@phosphor-icons/react";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  BugIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatTextIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
  CopyIcon,
  CrosshairIcon,
  DatabaseIcon,
  FileCodeIcon,
  FlowArrowIcon,
  FolderOpenIcon,
  GearSixIcon,
  GitDiffIcon,
  GithubLogoIcon,
  GraphIcon,
  HouseIcon,
  InfoIcon as PInfoIcon,
  KeyIcon,
  LightningIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  OctagonIcon,
  PaperPlaneTiltIcon,
  PlayIcon,
  PlusIcon,
  ProhibitIcon,
  ReceiptIcon,
  RobotIcon,
  SidebarSimpleIcon,
  SkipBackIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SquaresFourIcon,
  StackIcon,
  StopIcon,
  SunIcon,
  TerminalWindowIcon,
  TestTubeIcon,
  TrashIcon,
  UsersIcon,
  WarningCircleIcon,
  WarningIcon,
  WaveformIcon,
  XIcon as PXIcon,
} from "@phosphor-icons/react/ssr";
import type { ComponentType } from "react";

export type Icon = ComponentType<IconProps>;

const light = (I: Icon, name: string): Icon => {
  const C = (p: IconProps) => <I weight="light" {...p} />;
  C.displayName = name;
  return C;
};

export const AlertTriangle = light(WarningIcon, "AlertTriangle");
export const TriangleAlert = AlertTriangle;
export const ArrowRight = light(ArrowRightIcon, "ArrowRight");
export const Bot = light(RobotIcon, "Bot");
export const Bug = light(BugIcon, "Bug");
export const Bento = light(SquaresFourIcon, "Bento");
export const Check = light(CheckIcon, "Check");
export const ChevronDown = light(CaretDownIcon, "ChevronDown");
export const ChevronLeft = light(CaretLeftIcon, "ChevronLeft");
export const ChevronRight = light(CaretRightIcon, "ChevronRight");
export const ChevronUp = light(CaretUpIcon, "ChevronUp");
export const CircleAlert = light(WarningCircleIcon, "CircleAlert");
export const CircleCheck = light(CheckCircleIcon, "CircleCheck");
export const Code = light(CodeIcon, "Code");
export const Copy = light(CopyIcon, "Copy");
export const Clock = light(ClockCounterClockwiseIcon, "Clock");
/** Restore a conversation to an earlier turn. */
export const Restore = light(SkipBackIcon, "Restore");
export const Key = light(KeyIcon, "Key");
export const Settings = light(GearSixIcon, "Settings");
export const Folder = light(FolderOpenIcon, "Folder");
export const Library = light(StackIcon, "Library");
export const Prohibit = light(ProhibitIcon, "Prohibit");
export const Crosshair = light(CrosshairIcon, "Crosshair");
export const Database = light(DatabaseIcon, "Database");
export const FileCode = light(FileCodeIcon, "FileCode");
export const Flow = light(FlowArrowIcon, "Flow");
export const GitDiff = light(GitDiffIcon, "GitDiff");
export const Github = light(GithubLogoIcon, "Github");
export const Home = light(HouseIcon, "Home");
export const Info = light(PInfoIcon, "Info");
export const Loader2 = light(CircleNotchIcon, "Loader2");
export const Play = light(PlayIcon, "Play");
export const Stop = light(StopIcon, "Stop");
export const Menu = light(ListIcon, "Menu");
export const MessageSquareText = light(ChatTextIcon, "MessageSquareText");
export const Moon = light(MoonIcon, "Moon");
export const Network = light(GraphIcon, "Network");
export const OctagonX = light(OctagonIcon, "OctagonX");
export const Plus = light(PlusIcon, "Plus");
export const Pulse = light(WaveformIcon, "Pulse");
export const Receipt = light(ReceiptIcon, "Receipt");
export const Refresh = light(ArrowsClockwiseIcon, "Refresh");
export const Search = light(MagnifyingGlassIcon, "Search");
export const Send = light(PaperPlaneTiltIcon, "Send");
export const Sidebar = light(SidebarSimpleIcon, "Sidebar");
export const Sliders = light(SlidersHorizontalIcon, "Sliders");
export const Sparkles = light(SparkleIcon, "Sparkles");
export const Sun = light(SunIcon, "Sun");
export const Terminal = light(TerminalWindowIcon, "Terminal");
export const TestTube = light(TestTubeIcon, "TestTube");
export const Trash = light(TrashIcon, "Trash");
export const Users = light(UsersIcon, "Users");
export const X = light(PXIcon, "X");
export const Zap = light(LightningIcon, "Zap");
// shadcn primitives (and the toaster) use the *Icon names
export {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  CircleCheck as CircleCheckIcon,
  Info as InfoIcon,
  Loader2 as Loader2Icon,
  OctagonX as OctagonXIcon,
  Search as SearchIcon,
  TriangleAlert as TriangleAlertIcon,
  X as XIcon,
};
