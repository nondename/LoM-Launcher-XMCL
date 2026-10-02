import { ServiceKey } from './Service'

export interface LocalCape {
  id: string
  name: string
  url: string
  source?: string
  dateAdded: number
}

export interface LocalCapeState {
  capes: LocalCape[]
  equippedCapeIds: Record<string, string>
}

export interface AddLocalCapeOptions {
  name: string
  source: string
}

export interface UpdateLocalCapeOptions {
  name?: string
}

export interface LocalCapeService {
  getState(): Promise<LocalCapeState>
  addCape(options: AddLocalCapeOptions): Promise<LocalCape>
  updateCape(id: string, options: UpdateLocalCapeOptions): Promise<LocalCape>
  removeCape(id: string): Promise<void>
  setEquippedCape(account: string, id: string): Promise<void>
}

export const LocalCapeServiceKey: ServiceKey<LocalCapeService> = 'LocalCapeService'
