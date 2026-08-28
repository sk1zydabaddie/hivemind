import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const DialogFocusContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null)

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const opener = React.useRef<HTMLElement | null>(null)
  const previousOpen = React.useRef(false)
  React.useEffect(() => {
    if (props.open === true && !previousOpen.current) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    previousOpen.current = props.open === true
  }, [props.open])
  return (
    <DialogFocusContext.Provider value={opener}>
      <DialogPrimitive.Root data-slot="dialog" {...props} />
    </DialogFocusContext.Provider>
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        /* A dark canvas scrim preserves context without washing the workbench
           grey. It is a flat fill: no backdrop filter and no false glass. */
        "fixed inset-0 z-50 bg-canvas/72 duration-[180ms] ease-[var(--spring)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  frame = false,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  frame?: boolean
  showCloseButton?: boolean
}) {
  const opener = React.useContext(DialogFocusContext)
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-rule bg-background shadow-[var(--elevation-overlay),var(--glass-edge-near)] p-5 duration-[240ms] ease-[var(--spring)] outline-none focus-visible:ring-[3px] focus-visible:ring-navy/25 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          frame && "gap-0 p-0",
          className
        )}
        {...props}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          const target = content.querySelector<HTMLElement>("[data-dialog-initial-focus], [data-slot='dialog-title']")
          target?.focus()
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          event.preventDefault()
          opener?.current?.focus()
        }}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3.5 right-3.5 grid size-6 cursor-pointer place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-canvas hover:text-ink disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({
  className,
  frame = false,
  ...props
}: React.ComponentProps<"div"> & { frame?: boolean }) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-2 text-center sm:text-left",
        frame && "border-b border-rule px-5 py-4",
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  frame = false,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  frame?: boolean
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        frame && "items-center border-t border-rule bg-canvas px-5 py-3",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      tabIndex={-1}
      className={cn(
        "text-[17px] leading-tight font-semibold tracking-tight text-ink",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-[13px] leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
