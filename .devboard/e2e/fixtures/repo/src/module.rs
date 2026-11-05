pub struct Counter {
    count: u64,
}

impl Counter {
    pub fn increment(&mut self) -> u64 {
        self.count += 1;
        self.count
    }
}
