export type CartItem = {
  product_id: string
  moq_group_id?: string
  moq_group_name?: string
  name: string
  image_url: string | null
  price: number
  currency: string
  unit?: string
  quantity: number
}

export type CustomerForm = {
  name: string
  phone: string
  email: string
  city: string
  address: string
  notes: string
}
