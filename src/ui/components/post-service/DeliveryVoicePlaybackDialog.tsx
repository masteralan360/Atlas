import { useTranslation } from "react-i18next";

import { Button } from "@/ui/components/button";
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from "@/ui/components";
import { FlacAudioPlayer } from "./FlacAudioPlayer";

export function DeliveryVoicePlaybackDialog({
  open,
  onOpenChange,
  path,
  shipmentLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string | null;
  shipmentLabel: string;
}) {
  const { t } = useTranslation();
  return <AppDialog open={open} onOpenChange={onOpenChange}>
    <AppDialogContent className="max-w-lg">
      <AppDialogHeader>
        <AppDialogTitle>{t("postService.voiceReason.playback")}</AppDialogTitle>
        <AppDialogDescription>{shipmentLabel}</AppDialogDescription>
      </AppDialogHeader>
      <AppDialogBody>
        {path && <FlacAudioPlayer source={{ kind: "storage", path }} />}
      </AppDialogBody>
      <AppDialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("postService.actions.cancel")}</Button>
      </AppDialogFooter>
    </AppDialogContent>
  </AppDialog>;
}
