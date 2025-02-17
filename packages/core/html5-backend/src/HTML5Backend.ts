import {
	Backend,
	DragDropManager,
	DragDropActions,
	DragDropMonitor,
	HandlerRegistry,
	Identifier,
} from 'dnd-core'
import EnterLeaveCounter from './EnterLeaveCounter'
import { isFirefox } from './BrowserDetector'
import {
	getNodeClientOffset,
	getEventClientOffset,
	getDragPreviewOffset,
} from './OffsetUtils'
import {
	createNativeDragSource,
	matchNativeItemType,
} from './NativeDragSources'
import * as NativeTypes from './NativeTypes'
import { NativeDragSource } from './NativeDragSources/NativeDragSource'
import { OptionsReader } from './OptionsReader'

declare global {
	interface Window {
		__isReactDndBackendSetUp: boolean | undefined
	}
}

export default class HTML5Backend implements Backend {
	private options: OptionsReader

	// React-Dnd Components
	private actions: DragDropActions
	private monitor: DragDropMonitor
	private registry: HandlerRegistry

	// Internal State
	private enterLeaveCounter: EnterLeaveCounter

	private sourcePreviewNodes: Map<string, Element> = new Map()
	private sourcePreviewNodeOptions: Map<string, any> = new Map()
	private sourceNodes: Map<string, Element> = new Map()
	private sourceNodeOptions: Map<string, any> = new Map()

	private dragStartSourceIds: string[] | null = null
	private dropTargetIds: string[] = []
	private dragEnterTargetIds: string[] = []
	private currentNativeSource: NativeDragSource | null = null
	private currentNativeHandle: Identifier | null = null
	private currentDragSourceNode: Element | null = null
	private altKeyPressed = false
	private mouseMoveTimeoutTimer: number | null = null
	private asyncEndDragFrameId: number | null = null
	private dragOverTargetIds: string[] | null = null

	public constructor(manager: DragDropManager, globalContext: any) {
		this.options = new OptionsReader(globalContext)
		this.actions = manager.getActions()
		this.monitor = manager.getMonitor()
		this.registry = manager.getRegistry()
		this.enterLeaveCounter = new EnterLeaveCounter(this.isNodeInDocument)
	}

	// public for test
	public get window() {
		return this.options.window
	}
	public get document() {
		return this.options.document
	}

	public setup() {
		if (this.window === undefined) {
			return
		}

		if (this.window.__isReactDndBackendSetUp) {
			throw new Error('Cannot have two HTML5 backends at the same time.')
		}
		this.window.__isReactDndBackendSetUp = true
		this.addEventListeners(this.window as Element)
	}

	public teardown() {
		if (this.window === undefined) {
			return
		}

		this.window.__isReactDndBackendSetUp = false
		this.removeEventListeners(this.window as Element)
		this.clearCurrentDragSourceNode()
		if (this.asyncEndDragFrameId) {
			this.window.cancelAnimationFrame(this.asyncEndDragFrameId)
		}
	}

	public connectDragPreview(sourceId: string, node: Element, options: any) {
		this.sourcePreviewNodeOptions.set(sourceId, options)
		this.sourcePreviewNodes.set(sourceId, node)

		return () => {
			this.sourcePreviewNodes.delete(sourceId)
			this.sourcePreviewNodeOptions.delete(sourceId)
		}
	}

	public connectDragSource(sourceId: string, node: Element, options: any) {
		this.sourceNodes.set(sourceId, node)
		this.sourceNodeOptions.set(sourceId, options)

		const handleDragStart = (e: any) => this.handleDragStart(e, sourceId)
		const handleSelectStart = (e: any) => this.handleSelectStart(e)

		node.setAttribute('draggable', 'true')
		node.addEventListener('dragstart', handleDragStart)
		node.addEventListener('selectstart', handleSelectStart)

		return () => {
			this.sourceNodes.delete(sourceId)
			this.sourceNodeOptions.delete(sourceId)

			node.removeEventListener('dragstart', handleDragStart)
			node.removeEventListener('selectstart', handleSelectStart)
			node.setAttribute('draggable', 'false')
		}
	}

	public connectDropTarget(targetId: string, node: HTMLElement) {
		const handleDragEnter = (e: DragEvent) => this.handleDragEnter(e, targetId)
		const handleDragOver = (e: DragEvent) => this.handleDragOver(e, targetId)
		const handleDrop = (e: DragEvent) => this.handleDrop(e, targetId)

		node.addEventListener('dragenter', handleDragEnter)
		node.addEventListener('dragover', handleDragOver)
		node.addEventListener('drop', handleDrop)

		return () => {
			node.removeEventListener('dragenter', handleDragEnter)
			node.removeEventListener('dragover', handleDragOver)
			node.removeEventListener('drop', handleDrop)
		}
	}

	private addEventListeners(target: Node) {
		// SSR Fix (https://github.com/react-dnd/react-dnd/pull/813
		if (!target.addEventListener) {
			return
		}
		target.addEventListener(
			'dragstart',
			this.handleTopDragStart as EventListener,
		)
		target.addEventListener('dragstart', this.handleTopDragStartCapture, true)
		target.addEventListener('dragend', this.handleTopDragEndCapture, true)
		target.addEventListener(
			'dragenter',
			this.handleTopDragEnter as EventListener,
		)
		target.addEventListener(
			'dragenter',
			this.handleTopDragEnterCapture as EventListener,
			true,
		)
		target.addEventListener(
			'dragleave',
			this.handleTopDragLeaveCapture as EventListener,
			true,
		)
		target.addEventListener('dragover', this.handleTopDragOver as EventListener)
		target.addEventListener('dragover', this.handleTopDragOverCapture, true)
		target.addEventListener('drop', this.handleTopDrop as EventListener)
		target.addEventListener(
			'drop',
			this.handleTopDropCapture as EventListener,
			true,
		)
	}

	private removeEventListeners(target: Node) {
		// SSR Fix (https://github.com/react-dnd/react-dnd/pull/813
		if (!target.removeEventListener) {
			return
		}
		target.removeEventListener('dragstart', this.handleTopDragStart as any)
		target.removeEventListener(
			'dragstart',
			this.handleTopDragStartCapture,
			true,
		)
		target.removeEventListener('dragend', this.handleTopDragEndCapture, true)
		target.removeEventListener(
			'dragenter',
			this.handleTopDragEnter as EventListener,
		)
		target.removeEventListener(
			'dragenter',
			this.handleTopDragEnterCapture as EventListener,
			true,
		)
		target.removeEventListener(
			'dragleave',
			this.handleTopDragLeaveCapture as EventListener,
			true,
		)
		target.removeEventListener(
			'dragover',
			this.handleTopDragOver as EventListener,
		)
		target.removeEventListener('dragover', this.handleTopDragOverCapture, true)
		target.removeEventListener('drop', this.handleTopDrop as EventListener)
		target.removeEventListener(
			'drop',
			this.handleTopDropCapture as EventListener,
			true,
		)
	}

	private getCurrentSourceNodeOptions() {
		const sourceId = this.monitor.getSourceId() as string
		const sourceNodeOptions = this.sourceNodeOptions.get(sourceId)

		return {
			dropEffect: this.altKeyPressed ? 'copy' : 'move',
			...(sourceNodeOptions || {}),
		}
	}

	private getCurrentDropEffect() {
		if (this.isDraggingNativeItem()) {
			// It makes more sense to default to 'copy' for native resources
			return 'copy'
		}

		return this.getCurrentSourceNodeOptions().dropEffect
	}

	private getCurrentSourcePreviewNodeOptions() {
		const sourceId = this.monitor.getSourceId() as string
		const sourcePreviewNodeOptions = this.sourcePreviewNodeOptions.get(sourceId)

		return {
			anchorX: 0.5,
			anchorY: 0.5,
			captureDraggingState: false,
			...(sourcePreviewNodeOptions || {}),
		}
	}

	private getSourceClientOffset = (sourceId: string) => {
		return getNodeClientOffset(this.sourceNodes.get(sourceId))
	}

	private isDraggingNativeItem() {
		const itemType = this.monitor.getItemType()
		return Object.keys(NativeTypes).some(
			(key: string) => (NativeTypes as any)[key] === itemType,
		)
	}

	private beginDragNativeItem(type: string) {
		this.clearCurrentDragSourceNode()

		this.currentNativeSource = createNativeDragSource(type)
		this.currentNativeHandle = this.registry.addSource(
			type,
			this.currentNativeSource,
		)
		this.actions.beginDrag([this.currentNativeHandle])
	}

	private endDragNativeItem = () => {
		if (!this.isDraggingNativeItem()) {
			return
		}

		this.actions.endDrag()
		this.registry.removeSource(this.currentNativeHandle!)
		this.currentNativeHandle = null
		this.currentNativeSource = null
	}

	private isNodeInDocument = (node: Node | null) => {
		// Check the node either in the main document or in the current context
		return this.document && this.document.body && document.body.contains(node)
	}

	private endDragIfSourceWasRemovedFromDOM = () => {
		const node = this.currentDragSourceNode
		if (this.isNodeInDocument(node)) {
			return
		}

		if (this.clearCurrentDragSourceNode()) {
			this.actions.endDrag()
		}
	}

	private setCurrentDragSourceNode(node: Element | null) {
		this.clearCurrentDragSourceNode()
		this.currentDragSourceNode = node

		// A timeout of > 0 is necessary to resolve Firefox issue referenced
		// See:
		//   * https://github.com/react-dnd/react-dnd/pull/928
		//   * https://github.com/react-dnd/react-dnd/issues/869
		const MOUSE_MOVE_TIMEOUT = 1000

		// Receiving a mouse event in the middle of a dragging operation
		// means it has ended and the drag source node disappeared from DOM,
		// so the browser didn't dispatch the dragend event.
		//
		// We need to wait before we start listening for mousemove events.
		// This is needed because the drag preview needs to be drawn or else it fires an 'mousemove' event
		// immediately in some browsers.
		//
		// See:
		//   * https://github.com/react-dnd/react-dnd/pull/928
		//   * https://github.com/react-dnd/react-dnd/issues/869
		//
		this.mouseMoveTimeoutTimer = (setTimeout(() => {
			return (
				this.window &&
				this.window.addEventListener(
					'mousemove',
					this.endDragIfSourceWasRemovedFromDOM,
					true,
				)
			)
		}, MOUSE_MOVE_TIMEOUT) as any) as number
	}

	private clearCurrentDragSourceNode() {
		if (this.currentDragSourceNode) {
			this.currentDragSourceNode = null

			if (this.window) {
				this.window.clearTimeout(this.mouseMoveTimeoutTimer || undefined)
				this.window.removeEventListener(
					'mousemove',
					this.endDragIfSourceWasRemovedFromDOM,
					true,
				)
			}

			this.mouseMoveTimeoutTimer = null
			return true
		}

		return false
	}

	private handleTopDragStartCapture = () => {
		this.clearCurrentDragSourceNode()
		this.dragStartSourceIds = []
	}

	private handleDragStart(e: DragEvent, sourceId: string) {
		console.log('gizim handleDragStart', { e, sourceId })
		if (e.defaultPrevented) {
			return
		}

		if (!this.dragStartSourceIds) {
			this.dragStartSourceIds = []
		}
		this.dragStartSourceIds.unshift(sourceId)
	}

	private handleTopDragStart = (e: DragEvent) => {
		if (e.defaultPrevented) {
			return
		}

		const { dragStartSourceIds } = this
		this.dragStartSourceIds = null

		const clientOffset = getEventClientOffset(e)

		// Avoid crashing if we missed a drop event or our previous drag died
		if (this.monitor.isDragging()) {
			this.actions.endDrag()
		}

		// Don't publish the source just yet (see why below)
		this.actions.beginDrag(dragStartSourceIds || [], {
			publishSource: false,
			getSourceClientOffset: this.getSourceClientOffset,
			clientOffset,
		})

		const { dataTransfer } = e
		const nativeType = matchNativeItemType(dataTransfer)

		if (this.monitor.isDragging()) {
			if (dataTransfer && typeof dataTransfer.setDragImage === 'function') {
				// Use custom drag image if user specifies it.
				// If child drag source refuses drag but parent agrees,
				// use parent's node as drag image. Neither works in IE though.
				const sourceId: string = this.monitor.getSourceId() as string
				const sourceNode = this.sourceNodes.get(sourceId)
				const dragPreview = this.sourcePreviewNodes.get(sourceId) || sourceNode

				if (dragPreview) {
					const {
						anchorX,
						anchorY,
						offsetX,
						offsetY,
					} = this.getCurrentSourcePreviewNodeOptions()
					const anchorPoint = { anchorX, anchorY }
					const offsetPoint = { offsetX, offsetY }
					const dragPreviewOffset = getDragPreviewOffset(
						sourceNode,
						dragPreview,
						clientOffset,
						anchorPoint,
						offsetPoint,
					)

					dataTransfer.setDragImage(
						dragPreview,
						dragPreviewOffset.x,
						dragPreviewOffset.y,
					)
				}
			}

			try {
				// Firefox won't drag without setting data
				dataTransfer!.setData('application/json', {} as any)
			} catch (err) {
				// IE doesn't support MIME types in setData
			}

			// Store drag source node so we can check whether
			// it is removed from DOM and trigger endDrag manually.
			this.setCurrentDragSourceNode(e.target as Element)

			// Now we are ready to publish the drag source.. or are we not?
			const { captureDraggingState } = this.getCurrentSourcePreviewNodeOptions()
			if (!captureDraggingState) {
				// Usually we want to publish it in the next tick so that browser
				// is able to screenshot the current (not yet dragging) state.
				//
				// It also neatly avoids a situation where render() returns null
				// in the same tick for the source element, and browser freaks out.
				setTimeout(() => this.actions.publishDragSource(), 0)
			} else {
				// In some cases the user may want to override this behavior, e.g.
				// to work around IE not supporting custom drag previews.
				//
				// When using a custom drag layer, the only way to prevent
				// the default drag preview from drawing in IE is to screenshot
				// the dragging state in which the node itself has zero opacity
				// and height. In this case, though, returning null from render()
				// will abruptly end the dragging, which is not obvious.
				//
				// This is the reason such behavior is strictly opt-in.
				this.actions.publishDragSource()
			}
		} else if (nativeType) {
			// A native item (such as URL) dragged from inside the document
			this.beginDragNativeItem(nativeType)
		} else if (
			dataTransfer &&
			!dataTransfer.types &&
			((e.target && !(e.target as Element).hasAttribute) ||
				!(e.target as Element).hasAttribute('draggable'))
		) {
			// Looks like a Safari bug: dataTransfer.types is null, but there was no draggable.
			// Just let it drag. It's a native type (URL or text) and will be picked up in
			// dragenter handler.
			return
		} else {
			// If by this time no drag source reacted, tell browser not to drag.
			e.preventDefault()
		}
	}

	private handleTopDragEndCapture = () => {
		if (this.clearCurrentDragSourceNode()) {
			// Firefox can dispatch this event in an infinite loop
			// if dragend handler does something like showing an alert.
			// Only proceed if we have not handled it already.
			this.actions.endDrag()
		}
	}

	private handleTopDragEnterCapture = (e: DragEvent) => {
		this.dragEnterTargetIds = []

		const isFirstEnter = this.enterLeaveCounter.enter(e.target)
		if (!isFirstEnter || this.monitor.isDragging()) {
			return
		}

		const { dataTransfer } = e
		const nativeType = matchNativeItemType(dataTransfer)

		if (nativeType) {
			// A native item (such as file or URL) dragged from outside the document
			this.beginDragNativeItem(nativeType)
		}
	}

	private handleDragEnter(e: DragEvent, targetId: string) {
		this.dragEnterTargetIds.unshift(targetId)
	}

	private handleTopDragEnter = (e: DragEvent) => {
		const { dragEnterTargetIds } = this
		this.dragEnterTargetIds = []

		if (!this.monitor.isDragging()) {
			// This is probably a native item type we don't understand.
			return
		}

		this.altKeyPressed = e.altKey

		if (!isFirefox()) {
			// Don't emit hover in `dragenter` on Firefox due to an edge case.
			// If the target changes position as the result of `dragenter`, Firefox
			// will still happily dispatch `dragover` despite target being no longer
			// there. The easy solution is to only fire `hover` in `dragover` on FF.
			this.actions.hover(dragEnterTargetIds, {
				clientOffset: getEventClientOffset(e),
			})
		}

		const canDrop = dragEnterTargetIds.some(targetId =>
			this.monitor.canDropOnTarget(targetId),
		)

		if (canDrop) {
			// IE requires this to fire dragover events
			e.preventDefault()
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = this.getCurrentDropEffect()
			}
		}
	}

	private handleTopDragOverCapture = () => {
		this.dragOverTargetIds = []
	}

	private handleDragOver(e: DragEvent, targetId: string) {
		if (this.dragOverTargetIds === null) {
			this.dragOverTargetIds = []
		}
		this.dragOverTargetIds.unshift(targetId)
	}

	private handleTopDragOver = (e: DragEvent) => {
		const { dragOverTargetIds } = this
		this.dragOverTargetIds = []

		if (!this.monitor.isDragging()) {
			// This is probably a native item type we don't understand.
			// Prevent default "drop and blow away the whole document" action.
			e.preventDefault()
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'none'
			}
			return
		}

		this.altKeyPressed = e.altKey

		this.actions.hover(dragOverTargetIds || [], {
			clientOffset: getEventClientOffset(e),
		})

		const canDrop = (dragOverTargetIds || []).some(targetId =>
			this.monitor.canDropOnTarget(targetId),
		)

		if (canDrop) {
			// Show user-specified drop effect.
			e.preventDefault()
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = this.getCurrentDropEffect()
			}
		} else if (this.isDraggingNativeItem()) {
			// Don't show a nice cursor but still prevent default
			// "drop and blow away the whole document" action.
			e.preventDefault()
		} else {
			e.preventDefault()
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'none'
			}
		}
	}

	private handleTopDragLeaveCapture = (e: DragEvent) => {
		if (this.isDraggingNativeItem()) {
			e.preventDefault()
		}

		const isLastLeave = this.enterLeaveCounter.leave(e.target)
		if (!isLastLeave) {
			return
		}

		if (this.isDraggingNativeItem()) {
			this.endDragNativeItem()
		}
	}

	private handleTopDropCapture = (e: DragEvent) => {
		this.dropTargetIds = []
		e.preventDefault()

		if (this.isDraggingNativeItem()) {
			this.currentNativeSource!.mutateItemByReadingDataTransfer(e.dataTransfer)
		}

		this.enterLeaveCounter.reset()
	}

	private handleDrop(e: DragEvent, targetId: string) {
		this.dropTargetIds.unshift(targetId)
	}

	private handleTopDrop = (e: DragEvent) => {
		const { dropTargetIds } = this
		this.dropTargetIds = []

		this.actions.hover(dropTargetIds, {
			clientOffset: getEventClientOffset(e),
		})
		this.actions.drop({ dropEffect: this.getCurrentDropEffect() })

		if (this.isDraggingNativeItem()) {
			this.endDragNativeItem()
		} else {
			this.endDragIfSourceWasRemovedFromDOM()
		}
	}

	private handleSelectStart = (e: DragEvent) => {
		const target = e.target as HTMLElement & { dragDrop: () => void }

		// Only IE requires us to explicitly say
		// we want drag drop operation to start
		if (typeof target.dragDrop !== 'function') {
			return
		}

		// Inputs and textareas should be selectable
		if (
			target.tagName === 'INPUT' ||
			target.tagName === 'SELECT' ||
			target.tagName === 'TEXTAREA' ||
			target.isContentEditable
		) {
			return
		}

		// For other targets, ask IE
		// to enable drag and drop
		e.preventDefault()
		target.dragDrop()
	}
}
